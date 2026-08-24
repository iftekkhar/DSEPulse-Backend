# DSE Pulse — Architecture & Policy

This is the binding reference for how this system is built and how it must stay
built. Every change to a scraper, a schema, a write path, or a data source goes
through this document first — if a change would violate something below, the
document wins and the change gets rethought, not the other way around.

## System architecture: two subsystems, two jobs

- **`pipeline/`** exists for exactly one job: **backfilling historical data
  through yesterday.** It scrapes/imports into its own staging DB
  (`pipeline/data/staging.db`), audits everything staged, and — only on
  explicit human confirmation (`--promote-main --confirm`) — promotes into the
  main DB. It is a CLI toolkit (`--fetch-company-list`, `--scrape-gap`,
  `--resume`, `--audit`, `--promote-main`), invoked on demand, not a live
  service. Once a backfill is promoted, `pipeline/`'s job is done until the
  next gap needs filling.
  **`pipeline/` is dev/local-only and must never run in a production
  deployment** (confirmed 2026-08-23) — no `pipeline/` process, cron, or CLI
  invocation belongs in a production environment; a human runs it locally,
  reviews the audit, and promotes. Production's only job is `server/`
  scraping today's data and serving the API. This is precisely why the
  reliability bar for `server/`'s own fetches (retries, no silent fallback
  values — see "Scrapers" below) cannot be lower than `pipeline/`'s: `server/`
  is the only thing actually unattended and running every single day.
- **`server/`** owns *today and future* data — the live, ongoing layer. It
  scrapes directly into the main DB (`data/dse.db`) on cron schedules (Job 1
  closing prices, Job 3 fundamentals delta) and serves the API the frontend
  reads from. This is the permanent, day-to-day operational half of the
  system. (Job 4/market breadth and `intraday_breadth_snapshot` were removed
  2026-08-23 — the table had no staging equivalent and the one row it ever
  held turned out to carry a fabricated `dsex_index` value matching a since-
  removed hardcoded fallback constant.)
- **Known architectural mismatch, not yet resolved:** `pipeline/src/scheduler.js`
  currently still runs two of its own live cron jobs (`pipeline.live_ticker`,
  `pipeline.eod_settlement`) that scrape *today's* data on an ongoing schedule
  and publish straight to the main DB — that's `server/`'s job, not
  `pipeline/`'s, under the model above. `server.closing_prices` (Job 1) and
  `pipeline.eod_settlement` fire at the identical minute (`30 15 * * 0-4`) as a
  direct consequence. Flagged 2026-08-22, retirement of both pipeline cron jobs
  proposed but deliberately deferred pending confirmation — see the scraper
  inventory below for the full list and current (all-disabled) state.
  **The dual-write race itself is now hard-blocked** (2026-08-22): both boot
  paths (`server/index.js`, `pipeline/src/scheduler.js`) call
  `assertNoConflictingScrapers()` and refuse to start if both sides of a
  mutually-exclusive pair are enabled — see `shared/scraper_registry.js`. This
  closes the silent-overwrite risk (the tier guard alone doesn't, since both
  jobs write the same Tier 1 tier and a same-tier overwrite is allowed by
  design); it does not retire the redundant pipeline cron jobs, which is still
  a separate, deferred decision. See `OPERATIONS.md` for the enable order this
  protects.

Neither subsystem writes to the other's database directly. The only bridge is
`pipeline/src/promotion/manual_promoter.js` talking to `server/`'s
`/api/ingest/*` HTTP endpoints — a real network boundary, not a shared
connection, so every field that crosses it has to be explicitly mapped, and
every mapping hop is a place the null/tier rules below can get quietly broken
(see the incidents at the bottom of this document — most of them happened at
exactly this boundary).

**Promotion syncs `price_history` and `dsex_market_history`, not just
upserts** (fixed 2026-08-23). Every promotion call always carries the
*complete* current staging state for its scope (the whole `stg_index_history`
table; one symbol's whole `stg_price_history` at a time) — so `/api/ingest/dsex`
and `/api/ingest/history` now also delete any main-DB row that's no longer
present in that payload, via `pruneOrphanedDSEXRows`/
`pruneOrphanedPriceHistoryRows` in `server/db.js`. Scoped two ways for safety:
only rows whose `source` is one `shared/source_tiers.js`'s
`PROMOTION_OWNED_SOURCES` lists for that table — as of the `STAGING_DB`
policy below, that's uniformly `['STAGING_DB']` for every promoted table
(`price_history`, `dsex_market_history`, `fundamentals_history`,
`company_list`) — never `DSE_LIVE_CLOSING`/`DSE_LIVE_TICKER`, which `server/`'s
own Job 1/Job 2 write directly and promotion has no visibility into. Both
prune functions also refuse to run against an empty valid-dates set (added
2026-08-23 after a real incident — see Known incidents — where an empty
`{"records":[]}` ingest payload was misread as "staging now has zero rows for
everything" and deleted every promoted row in the table instead of a no-op).
Before the sync fix itself, deleting a row
from staging (e.g. the 2026-08-23 KAGGLE/`MCAP_WEIGHTED_ESTIMATE` cleanup, 60
rows found to not hold up under live cross-check) had no effect on the main
DB if that row had already been promoted once — it just sat there
indefinitely, since promotion only ever added/updated. `fundamentals_history`
is deliberately NOT synced this way — see "Historical data is
additive-only" below; that table's design intentionally prevents even a real
correction from happening automatically.

## Core principle

Every value this system stores or serves must trace to one of two things:

1. **A real, disclosed number from an approved source** (see Tier system below).
2. **An exact arithmetic derivation from real values that are themselves rule (1).**

A genuinely unknown value is `null`. Never a plausible-looking substitute — not `0`,
not a copied neighboring field, not a curve-fit estimate presented as fact. If a
consumer needs to distinguish "the market reported zero" from "we don't have this
number," `null` is the only value that preserves that distinction.

## The fabrication test

Before any field gets a value, it should be possible to answer: **"What real source,
or what formula over which real inputs, produced this exact number?"** If the honest
answer is "a plausible guess" or "a fallback because the real value was missing," the
field must be `null` instead.

## Legitimate derivation vs. fabrication

| Legitimate (real inputs, exact formula) | Fabrication (invented, no real basis) |
|---|---|
| `change = close - ycp` (both real) | `Math.sin`/`Math.cos`/`Math.random`-based value synthesis |
| `roe = eps / navps * 100` (both real) | Hardcoded fallback constants (e.g. a fixed DSEX value, fixed breadth counts) |
| SMA/EMA/RSI/MACD/Bollinger/ATR computed from a real price series | `ycp ?? close` — silently fabricates a 0% change by defaulting yesterday's price to today's |
| CAGR/Sharpe/max-drawdown from real historical closes | `field !== undefined ? Number(field) : null` — misses the `null` case; `Number(null)` is `0`, so a real null silently becomes a fabricated zero |
| A market-cap-weighted index reconstruction from real per-company data, labeled `MCAP_WEIGHTED_ESTIMATE` and tracked as Tier 3 | Any of the above presented as `DSE_OFFICIAL` or `'Audited'` without actually being sourced that way |

The dividing line isn't "was a formula involved" — it's whether every input to that
formula is itself real. A derived value from real inputs is fine even if unusual
(e.g. an ROE of 40% is jarring but correct if eps/navps are both real). A plausible
number from no real input is never fine, no matter how realistic it looks.

## The tier system — `shared/source_tiers.js`

Every source this system trusts has an explicit tier, and every row that carries
a value traceable to a specific source records which one:

- **Tier 1 — DSE official.** Scraped or promoted directly from dsebd.org:
  `DSE_OFFICIAL_ARCHIVE`, `DSE_OFFICIAL_BENCHMARK`, `DSE_SCRAPE`, `DSE_OFFICIAL`
  (fundamentals), `DSE_LIVE_CLOSING`, `DSE_LIVE_TICKER`.
- **Tier 2 — LankaBangla.** `LANKABD`, the approved secondary real-data source.
- **Tier 3 — approved supplementary/derived.** Real data, grounded in a real
  dataset or a real computation over real inputs, but not itself DSE- or
  LankaBangla-original: `KAGGLE` (a compiled historical dataset used before
  `DSE_SCRAPE`/`LANKABD` took over a given period) and
  `MCAP_WEIGHTED_ESTIMATE` (a market-cap-weighted DSEX reconstruction from real
  per-company data, for a period with no other real index source available).
  Approved 2026-08-22 specifically for the existing `stg_index_history` rows
  already using them — adding a *new* Tier 3 source requires the same explicit
  review, not a standing license.

**This is enforced, not just documented.** `server/audit/db_auditor.js` checks
every `source` value actually present in main DB's tables against
`shared/source_tiers.js`'s approved list — an unrecognized source is a hard
error, same severity as a fabricated zero.

## Main DB source policy: `STAGING_DB` (2026-08-23)

Every main-DB write path now tags `source` with one of exactly two kinds of
value, and every table that receives promoted data has a `source` column
(`price_history`, `dsex_market_history`, `fundamentals_history`,
`company_list` — the last two didn't track provenance at all before this):

- **`STAGING_DB`** (Tier 1) — the row was promoted from staging. Staging
  itself is declared Tier 1 for main DB's purposes: main DB doesn't need to
  know which specific staging-internal tier (`DSE_SCRAPE`/`LANKABD`/
  `DSE_OFFICIAL_GRAPH`/etc.) produced a value, only that it passed staging's
  audit + promotion gate. The granular tier still matters and is still
  tracked — inside `stg_*` tables, where `tierAllowsOverwrite` needs it to
  arbitrate between competing staging scrapers. It just doesn't cross into
  main DB anymore; `STAGING_DB` replaces it there uniformly.
- **A real live-source tag** (`DSE_LIVE_CLOSING`, `DSE_LIVE_TICKER`,
  `DSE_OFFICIAL`) — the row came from a `server/` job scraping *today's* data
  directly, bypassing staging entirely (per the two-subsystem split at the
  top of this document). These jobs never touch staging's database at all,
  in either direction — not to read from it, not to write to it.

Any other value is unapproved and gets dropped, same as any other
unapproved-source violation.

`price_history` is currently 100% `STAGING_DB` (1,101,211 rows) --
`dsex_market_history`, `fundamentals_history`, and `company_list` likewise,
100% `STAGING_DB` — no live rows exist yet since Job 1/2/3 haven't run this
session.

`dsex_market_history` was ~30% Tier 3 (`KAGGLE`/`MCAP_WEIGHTED_ESTIMATE`)
until 2026-08-23, when `DSE_OFFICIAL_GRAPH` (dsebd.org's own chart-data
endpoint, `php_graph/monthly_graph_index.php?type=dseX&duration=N` — a real
DSEX history feed reaching back to 2013, distinct from the two endpoints
already used) was found and used to cross-check + upgrade it: all 477
existing Tier 1 rows were confirmed exactly matching (0 mismatches, nothing
overwritten), and 2,754 of 2,808 Tier 3 rows were upgraded to real Tier 1
data. As of 2026-08-24, the remaining 57 `MCAP_WEIGHTED_ESTIMATE` rows have
also been upgraded (`DSE_OFFICIAL_ARCHIVE`/`DSE_OFFICIAL_BENCHMARK`) --
`stg_index_history` is now **100% Tier 1** (2,754 `DSE_OFFICIAL_GRAPH` + 447
`DSE_OFFICIAL_ARCHIVE` + 30 `DSE_OFFICIAL_BENCHMARK`, 0 Tier 3 rows remain).

The 3 `KAGGLE` rows were investigated and deleted, not upgraded: each was
within 0.01 index points of the immediately-preceding real session's close
(2016-09-14 vs. real 2016-09-08: diff 0.007; 2019-02-28 vs. real 2019-02-27:
diff 0.010; 2020-03-29 vs. real 2020-03-25: diff 0.008) with zero
`stg_price_history` rows for any of the 3 dates — the signature of a
forward-filled duplicate on a day the market was actually closed (2020-03-29
falls inside Bangladesh's COVID-19 market closure), not a genuine trading
session KAGGLE alone had visibility into. Recording a value for a non-trading
day would violate the "a real gap stays visible, never silently filled" rule
regardless of source tier, so these were removed entirely rather than
replaced with a computed estimate.

## Historical data is additive-only for AUDITED rows, never silently replaced

**Schema change, 2026-08-23: `company_fundamentals` was dropped.** Main DB no
longer has a separate single-row-per-symbol "current fundamentals" table.
`fundamentals_history` (one row per company per fiscal year) is now the only
fundamentals table, and "current" is derived by querying each symbol's latest
`fiscal_year` row from it (see `LATEST_FUNDAMENTALS_CTE` in `server/db.js`,
reused by `getAllFundamentalsMap`, `getAllStocksFromDB`, and
`getDetailedHistoricalAnalysis`). `name`/`sector`/`category` — fields
`company_fundamentals` used to carry — now come from `company_list` (below)
via a join; duplicating them across two tables was the original design smell,
not something worth preserving.

Every row in `fundamentals_history` carries `audit_status`, either `'Audited'`
(promoted from staging via `/api/ingest/fundamentals`, an audited annual
disclosure) or `'Provisional'` (written directly by Job 3's daily delta
tracking of a still-forming, not-yet-fully-audited period). The immutability
rule is now stated per-status, not per-table:

- **An `'Audited'` row is never overwritten by anything** — not a routine
  scrape, not a later promotion run. Enforced by
  `... ON CONFLICT(symbol, fiscal_year) DO UPDATE SET ... WHERE
  fundamentals_history.audit_status IS NOT 'Audited'` in both
  `/api/ingest/fundamentals` (promotion) and `saveFundamentalsBulkDelta`
  (Job 3) — the `WHERE` clause makes the whole `DO UPDATE` a no-op whenever the
  existing row is already Audited, in both write paths.
- **A `'Provisional'` row can be freely updated** — by Job 3 as new interim
  figures come in, or upgraded to `'Audited'` by a later promotion once the
  disclosure is actually audited and staged. This replaces the old blanket
  `DO NOTHING` on promotion, which had a real gap: if Job 3's provisional
  tracking reached a (symbol, fiscal_year) first, `DO NOTHING` would have
  permanently blocked the real audited disclosure from ever landing for that
  year once promotion tried to write it.

If DSE genuinely restates an already-Audited prior disclosure, that's a rare,
deliberate manual correction (direct SQL, with a backup first) — not something
either write path does automatically.

## `company_list` and `audit_reports` — added to main DB, 2026-08-23

`company_list` mirrors `stg_company_list`'s schema exactly and is promoted the
same way as price/index/fundamentals (`saveCompanyList` in `server/db.js`,
via `/api/ingest/companylist`) — a full sync: every promotion run upserts the
complete current staging roster and prunes any symbol no longer in it. Unlike
`price_history`/`dsex_market_history`, this table has no live writer of its
own (no `server/` job touches the instrument roster), so the prune needs no
source-based scoping.

`audit_reports` mirrors staging's `audit_reports` shape but is a completely
separate, main-DB-local audit log — **never synced from staging's, never
written by promotion.** The only thing that ever writes to it is
`server/audit/db_auditor.js`'s `auditMainDB()`, via `saveMainDBAuditReport`,
each time the main-DB audit actually runs (`npm run audit:main-db`). Staging's
audit history and main DB's audit history are different facts about different
databases; conflating them would misrepresent which DB was actually checked
at each recorded run.

## Null-handling standard — one implementation, not a convention

This used to be a set of rules re-derived (and re-gotten-slightly-wrong) by hand at
every call site — which is exactly how the same bug class kept recurring under
different disguises (see the incidents below). It is now a single shared
implementation everyone imports instead of reimplementing:

```js
import { numOrNull, positiveNumOrNull, deriveOrNull, sumTerm, roundOrNull } from '../shared/safe_number.js';
```

- **Never `||` for a numeric fallback.** `||` treats a real `0` the same as
  missing data. Always `??`, or better, one of the helpers below.
- **`numOrNull(value)`** — the one place "is this usable as a number" gets
  decided. Handles `null`/`undefined`/`''`/`'-'`/`'N/A'`/unparseable strings/
  comma-formatted numbers, all returning `null`. Use this instead of hand-rolling
  `field !== null && field !== undefined ? Number(field) : null` at each call
  site — the hand-rolled version is exactly what went wrong repeatedly (see
  incidents below): easy to write as `field !== undefined ? ... : null`
  instead, which compiles, looks right, and silently lets `null` through into
  `Number(null)` → `0`.
- **`positiveNumOrNull(value)`** — like `numOrNull`, but also rejects `0` and
  negatives. Use for fields that are structurally impossible at exactly `0` for a
  real listed company (P/E, paid-up capital, a traded close price).
- **`deriveOrNull(a, b, fn)`** — the only sanctioned way to fill in a value from
  *other* values: combines two real numbers via exact arithmetic, returns `null`
  if either input isn't real. Never used to borrow one field's value as another
  (`ycp` from `close`) — only to compute a genuinely different quantity.
- **`sumTerm(value)`** — the one sanctioned `?? 0`: a loop-local running-total
  accumulator, where a missing per-record value should contribute nothing to the
  sum. Never for a value that gets stored/returned/displayed as its own field.
- Exception to all of the above: a schema column with a real `NOT NULL`
  constraint (e.g. `price_history.close`, `dsex_market_history.dsex_index`) can't
  hold `null`. For those, an unknown value means **skip the write** for that row,
  not "insert a fabricated placeholder that satisfies the constraint."
- `!== undefined` is *not* a null check, and neither is `!isNaN(x)` (`isNaN(null)`
  is `false` in JavaScript). `field !== undefined ? Number(field) : fallback`
  still lets a real `null` fall through into `Number(null)` → `0`. This is
  exactly what `numOrNull` exists to make impossible to get wrong again.

`shared/code_audit.js` flags any hand-rolled `!== undefined` check without a
matching `!== null` on the same line — a warning, not a hard error, since it can't
always tell a data-nullability check from an unrelated "was this optional argument
passed" check. Every real hit found so far has been the former.

## Per-domain rules

### 1. Backend (`server/`)

- No auto-seed/backfill functions that synthesize data on demand when a table looks
  sparse. If the DB has little or no data for something, the API returns that
  honestly (empty array / `null` fields) — never fills the gap with a generated
  substitute.
- Every `save*`/`ingest` function preserves `null` through the full write path,
  including nested per-field mapping (a single missed `?? otherField` at any hop
  between the HTTP payload and the SQL parameters reintroduces fabrication even if
  every other hop is correct — see the incidents below, most of which happened at
  exactly this kind of hop).
- API endpoints never return a hardcoded fallback "snapshot" object when live/cached
  data is unavailable — return `null`/empty and let the client render its own
  loading/empty state.

### 2. Scrapers (`pipeline/src/scrapers/`, `server/scrapers/`)

- **Every scraper is off by default.** `shared/scraper_registry.js` is the single
  kill-switch for all of them — cron schedules, CLI flags, and on-demand API routes
  all check `isScraperEnabled('key')` before running and refuse otherwise; none of
  them have their own separate bypass. Bringing a scraper live is a deliberate,
  one-line edit to that file (`enabled: false` → `true`), not an implicit
  consequence of the process starting up. `npm test` asserts that not a single
  scraper is enabled by default — that assertion failing means someone flipped one
  on without meaning to commit it that way.
- **Every scraper audits its output before it reaches a DB write** — staging or
  main, there is no exemption for "it's just staging, there's a promotion gate
  later." Each scraper calls `DataAuditor` (`shared/data_auditor.js`) on what it
  scraped and only stages/saves records that pass; a failed record is logged and
  skipped, not silently written anyway. This is a second, independent gate in
  front of the promotion-time audit, not a replacement for it — it catches a bad
  scrape before it's sitting in staging at all, rather than only at the point
  someone runs `--promote-main`.
- Every field traces to a specific parsed location in a specific source response. A
  failed parse or a missing column returns `null` for that field — never a
  hardcoded number standing in for "the scrape didn't work," and never assumed
  from a "usually true" domain default (BDT 10 face value is the common case on
  DSE, not universal — assuming it for an unlisted value corrupts every derived
  field that reads it, e.g. cash DPS from a dividend %).
- A failed fetch retries (via `shared/dse_http_client.js`'s `fetchWithRetry`) before
  giving up; giving up means returning `null`/empty, not a stale cached value
  presented as current.
- Every staged/promoted record carries a real tier-approved source label (see
  Tier system above) — never a default like `'DSE_OFFICIAL'` applied to data
  whose actual provenance wasn't confirmed.

#### Scraper inventory (`shared/scraper_registry.js`) — 17 total

| Key | What it scrapes | Writes to |
|---|---|---|
| `pipeline.live_ticker` | Live DSE snapshot, every 5 min in trading hours | main DB (via `/api/ingest/live`) — *architectural mismatch, see System architecture above* |
| `pipeline.eod_settlement` | EOD closing snapshot, 15:30 BST | main DB (via `/api/ingest/live`) — *same mismatch, now hard-blocked from running alongside `server.closing_prices`* |
| `pipeline.gap_scraper_price` | Price history gap-fill | `stg_price_history` |
| `pipeline.gap_scraper_index` | DSEX index gap-fill | `stg_index_history` |
| `pipeline.fundamentals_scraper` | Official audited annual fundamentals | `stg_annual_fundamentals` |
| `pipeline.company_list_scraper` | Active company list + details (full instrument roster) | `stg_company_list` |
| `pipeline.dse_index_graph` | Real DSEX history from dsebd.org's chart endpoint (Tier 1) | `stg_index_history`, `source=DSE_OFFICIAL_GRAPH` -- Tier 3 rows only, or previously-missing dates |
| `pipeline.lankabd_scraper` | Real daily price history from lankabd.com (Tier 2) | `stg_price_history`, `source=LANKABD` |
| `pipeline.external_crosscheck_lankabd` | Read-only cross-validation vs. lankabd.com | `audit_reports` (staging) + a CSV, no price/fundamentals data |
| `pipeline.external_crosscheck_dse_prices` | Read-only live cross-validation of `stg_price_history` vs. dsebd.org | `audit_reports` (staging) + a CSV |
| `pipeline.external_crosscheck_dse_fundamentals` | Read-only live cross-validation of `stg_annual_fundamentals` vs. dsebd.org | `audit_reports` (staging) + a CSV |
| `pipeline.external_crosscheck_dse_index` | Read-only live cross-validation of `stg_index_history` Tier 1 rows vs. dsebd.org (reachable window only) | `audit_reports` (staging) + a CSV |
| `pipeline.external_crosscheck_dse_companylist` | Read-only live cross-validation of `stg_company_list` vs. dsebd.org's live roster | `audit_reports` (staging) + a CSV |
| `server.closing_prices` | Official daily closing prices (Job 1) | `price_history`, `dsex_market_history` |
| `server.live_ticker` | Live intraday ticker (Job 2, on-demand only) | none — session-only API response |
| `server.fundamentals_delta` | Daily audited EPS delta (Job 3) | `fundamentals_history` (`'Provisional'` rows) |
| `server.fundamentals_weekly` | Manual on-demand full-universe audited EPS crawl | `fundamentals_history` (`'Provisional'` rows) |

(Job 4/`server.market_breadth` was removed 2026-08-23 along with
`intraday_breadth_snapshot`.)

`shared/scraper_registry.js` also exports `MUTUALLY_EXCLUSIVE_SCRAPER_PAIRS` and
`assertNoConflictingScrapers()` — pairs that write the same data via the same
path and must never both be `enabled: true` at once. Currently one pair:
`['server.closing_prices', 'pipeline.eod_settlement']`. Both `server/index.js`
and `pipeline/src/scheduler.js` call this at boot and refuse to start if
violated — see `OPERATIONS.md` for the safe enable procedure this exists to
protect.

**Resolved 2026-08-22:** `server.fundamentals_delta` and `server.fundamentals_weekly`
were confirmed to run the identical `scrapeCompanyAuditedFinancials` -> audit ->
`saveFundamentalsBulkDelta` pipeline against effectively the same symbol
universe, with no functional difference found — the weekly cron was pure
redundancy on top of Job 3's daily run, not a distinct check. The Saturday cron
trigger was removed; `runAuditedEPSWeeklyScraper` itself is kept only for its
one real remaining use, `scripts/scrape_audited_eps.js` (a manual on-demand
full-universe re-scrape, distinct from Job 3's automatic daily delta).

Run `node -e "import('./shared/scraper_registry.js').then(m => console.table(m.listScrapers()))"`
for the live enabled/disabled state of all of them at a glance.

### 3. Main DB data (`data/dse.db`)

- Valid ranges (violations are hard errors, not warnings):
  - `dsex_market_history.dsex_index`: 500–20000 (DSEX has never traded outside this
    band).
  - `price_history.close`: > 0.
  - Any `pe_ratio` / `pe_basic` / `pe_diluted` / `pe_trailing` /
    `paid_up_capital_mn` that is present must be **non-zero** — both are structurally
    impossible at exactly `0` for a real listed company. If undisclosed, the field
    must be `null`, not `0`.
  - `dsex_market_history` breadth signature `advancing=180, declining=140,
    unchanged=60` on any row is an automatic hard error — this is the exact
    hardcoded output of the deleted `pipeline/src/builders/dsex_builder.js`
    generator, and no real trading session produces that triple.
  - Every `source` value present in `price_history`/`dsex_market_history` must
    be on `shared/source_tiers.js`'s approved list (see Tier system above).
- Statistical warnings (reported, not blocking — needs a human glance since some are
  legitimately real): EPS outside -200 to 1000, NAVPS ≤ 0, P/E outside 0–300.
- Every row should be traceable to a staging promotion (`manual_promoter.js` via
  `--promote-main --confirm`) or one of `server/`'s live cron jobs — never a
  direct write from a standalone script outside that path.
- Job 1, Job 3, and the weekly audited-EPS crawler each run their
  scraped output through `DataAuditor` (`shared/data_auditor.js`) before their
  respective `save*` call. A blocked write is logged and the job's status
  reflects it (`jobStatusRegistry`) rather than failing silently.
- Run `npm run audit:main-db` to check current state (`server/audit/db_auditor.js`).
  This is a read-only report on what's already landed — it complements the
  write-time gates above, it doesn't replace them; it's how drift from a bug in
  the gate itself, or a write that predates it, gets caught after the fact.

### 4. Pipeline Staging DB data (`pipeline/data/staging.db`)

- Already enforced: `shared/data_auditor.js` + `audit_runner.js` gate every
  promotion behind a `CERTIFIED_PASSED` result (0 blocking errors). This is the
  mandatory checkpoint — nothing should reach the main DB through
  `manual_promoter.js` without passing it first. Each staging scraper additionally
  self-audits before its own stage-write (see Scrapers above) — this is two
  gates, not one: per-scrape at staging time, and per-promotion at main-DB time.
- Same range/null/tier rules as Main DB data above (staging is audited with the
  same thresholds so a certified promotion doesn't need re-deriving separately).
- Run `npm run pipeline:audit` to check current state.

## Main DB audit: cell-by-cell staging comparison (2026-08-23)

`npm run audit:main-db` (`server/audit/db_auditor.js`) does two independent
things now, not just one:

1. The original range/null/tier checks (P/E=0, NAVPS≤0, unapproved source,
   etc.) — statistical sanity over what's actually sitting in main DB.
2. **A cell-by-cell comparison against the staging row each `STAGING_DB`-
   tagged row was promoted from** (`server/audit/staging_comparison.js`),
   for all four promoted tables. `price_history` is held to a stricter
   standard than the other three: **any** cell mismatch there is a hard
   `AUDIT_FAILED` error, not a warning — this table must match staging 100%,
   given how foundational it is. `dsex_market_history`/`fundamentals_history`/
   `company_list` mismatches are reported as warnings (drift worth a human
   glance, same severity tier as the existing statistical warnings).

Rows tagged with a live source instead of `STAGING_DB` have no staging
counterpart to compare against by design (staging only covers history through
yesterday) — these are checked against **fresh DSE data only**
(`server/audit/live_data_check.js`), never LankaBD, never staging, since DSE
is the one source the live scrapers themselves actually use. Call
`auditMainDB({ skipPrice: true })` to run everything except the `price_history`
checks (useful when you specifically want the *other* tables' state without
waiting on the biggest table's full comparison).

**The audit is read-only in both directions, always.** It never rewrites main
DB (that's `server/`'s live jobs' and the promoter's job, not the auditor's)
and it never rewrites staging either. If it finds a real mismatch, that means
staging's own data disagrees with what main DB currently holds — the fix is
to correct staging first (the source of truth), then re-run promotion; never
to patch main DB directly, and never something this tool does automatically.

## How to run the audits

```bash
npm test                  # shared/, plus the highest-risk scraper parsing logic
npm run pipeline:audit    # Pipeline Staging DB — gates promotion
npm run audit:main-db     # Main DB (data/dse.db) — data-level, read-only report,
                           # includes the cell-by-cell staging comparison above
npm run audit:code        # Backend + Pipeline + shared source — static pattern check
npm run audit:all         # audit:code + pipeline:audit + audit:main-db, in sequence
```

(`cd pipeline && npm test` also still runs pipeline's own smaller `DataAuditor`
regression suite — the two are complementary, not duplicates.)

`audit:code` splits findings into two tiers, same as the data auditors:

- **Errors** (block `CERTIFIED_PASSED`): `Math.random()` / `Math.sin()` / `Math.cos()`
  anywhere in `server/`, `pipeline/src/`, or `shared/` — there is no legitimate use
  for trigonometric or random synthesis in exact financial arithmetic — and `ycp`
  defaulting to a same-day price field (`close` or `ltp`, via `??` or `||`) on the
  same line, the specific historical bug that fabricated 0% daily changes.
- **Warnings** (reported, not blocking): every `|| 0` / `?? 0`, and every
  hand-rolled `!== undefined` check missing a matching `!== null`. These patterns
  *are* sometimes legitimate (summing a possibly-sparse array, a retry counter, a
  display fallback, an "was this optional arg passed" check unrelated to data
  nullability), so the tool can't reliably tell those apart from a real bug by
  regex alone — it reports every instance for a human to triage rather than
  guessing.

`npm test` (`shared/test_suite.js`, 63 cases) covers `safe_number.js` (all 5
helpers), `data_auditor.js` (all 5 audit methods, one regression case per
incident below), `source_tiers.js` (the approved list), `scraper_registry.js`
(asserts every scraper defaults off), and the highest-risk pure parsing logic
pulled out of the scrapers for direct testing without a live HTTP round-trip —
`fundamentals_scraper.js`'s multi-group table resolution
(`lastNumberInGroup`/`headlineOrContinuing`), the most intricate parsing in the
codebase and the one most likely to silently misread a layout change.

## Known incidents

Kept as a record, not just fixed and forgotten — every one of these is the same
underlying failure mode (a null silently becoming a fabricated value at some
hop in a mapping chain) wearing a different disguise. The pattern across all
four is why the shared implementations above exist instead of a written
convention: a convention has to be correctly reproduced by hand every time; a
shared function only has to be correct once.

**1. `fundamentals_history` (2026-08-22).** `server/index.js`'s
`/api/ingest/fundamentals` handler wrote each field as
`s.field !== undefined ? Number(s.field) : null`, missing the `null` case
(`Number(null)` is `0`). 532 rows with `pe_ratio = 0`, 1,610 with
`paid_up_capital_mn = 0`, both counts matching staging's real null-counts
exactly. Fixed; existing rows corrected from staging's known-good values.

**2. `ycp` defaulted to a same-day price field, three times (2026-08-22).**
The canonical example bug — `ycp` silently defaulting to `close`/`ltp`,
fabricating a 0% change — recurred independently in
`pipeline/src/promotion/manual_promoter.js` (`ycp: r.ycp ?? r.close`),
`pipeline/src/scrapers/live_scraper.js` (`|| ltp` instead of `?? close`), and
`server/index.js`'s `runJob2IntradaySync()` (`base.ycp || liveLtp`, plus a
second occurrence in its circuit-breaker branch). `code_audit.js`'s detector
originally matched only the first instance's exact syntax and missed the other
two until broadened to cover both operators and both fallback targets.

**3. The same `!== undefined` bug, three more places (2026-08-22).**
Broadening `code_audit.js` to `shared/` found the identical pattern in
`server/db.js`'s `saveFundamentals()`/`saveFundamentalsBulkDelta()` — 12 fields
each, writing to `company_fundamentals`, the live current-snapshot table.
Current data was clean (verified directly) but the bug was real. A companion
bug in the delta-comparison logic (`Number(existing) !== Number(new)`, same
null-through-`Number()` coercion) was also fixed. A third instance turned up in
`runJob2IntradaySync()`'s circuit-breaker: `!== undefined && !isNaN(x)` looks
like a null guard but isn't (`isNaN(null)` is `false`).

**4. Dropped source labels and a field-name mismatch at `/api/ingest/live`
(2026-08-22).** Two separate findings from the same review pass: first, that
`dsex_market_history`/`price_history` had no `source` column at all, so
staging's real per-row tier label (Tier 1 vs. the approved Tier 3
`MCAP_WEIGHTED_ESTIMATE`) was silently dropped on every promotion — fixed by
adding the column, threading `source` through every write path, and
backfilling all 970,751 existing rows from staging's real labels (see the Tier
system section above). Second, while fixing that, `/api/ingest/live`'s
`saveDSEXDailyClosing` call turned out to pass `turnoverMn`/`volume` where the
function actually reads `totalTrades`/`totalVolume`/`totalValueMn` — silently
dropping breadth figures on every call through this endpoint, the same
field-name-mismatch bug already found and fixed at `/api/ingest/dsex` but
missed here because it's a separate call site. Both endpoints now use
`numOrNull` consistently instead of each keeping its own local reimplementation.

**5. Empty-array ingest payload wiped a whole table (2026-08-23).** A live
endpoint test — `POST /api/ingest/dsex` with `{"records":[]}`, meant to be a
harmless no-op probe — deleted all 3,231 rows of `dsex_market_history` in the
live main DB. `pruneOrphanedDSEXRows(validDates)`/
`pruneOrphanedPriceHistoryRows(symbol, validDates)` treated an empty
`validDates` array as "staging now has zero valid dates for this scope, so
every existing row is orphaned" instead of recognizing it as "no information
was sent, do nothing." Fixed with an early-return guard in both functions:
an empty (or missing) `validDates` array now logs a warning and returns `0`
rather than pruning. `saveCompanyList` already had an equivalent guard
(`if (!records.length) return ...`) and was unaffected. Data restored via a
clean re-promotion from staging, which was never touched. The lesson
generalizes: **any full-sync/prune write path keyed off an incoming payload
must treat an empty payload as "unknown," never as "confirmed empty."**

**6. `server/`'s own daily scrapers had no retry, while `pipeline/`'s did
(found 2026-08-23).** This document already stated "a failed fetch retries
via `fetchWithRetry` before giving up" as a universal scraper rule (see
Scrapers below), and `shared/dse_http_client.js` existed — but `server/`
never actually adopted it. `fetchDSEClosingPrices`, `fetchDSELiveTicker`,
`fetchMarketBreadthFromDSE` (`server/index.js`, feeding Job 1) and
`scrapeCompanyAuditedFinancials` (`server/scrapers/audited_eps_scraper.js`,
feeding both Job 3's daily delta and the on-demand weekly full crawl) were
all still one-shot `axios.get` calls. This was backwards for the roles the
two subsystems actually have post-2026-08-23: `pipeline/` is dev-only and
human-supervised (see System architecture above), so a scrape failure there
just means a person notices and re-runs it; `server/` is the only thing
running unattended in production every day, so the exact same failure there
means silently missing that day's data (Job 1 logging "Market Holiday /
Off-hours" for what was actually a transient timeout). Fixed by routing all
four functions through `fetchWithRetry` with the same 3-attempts/backoff
shape `pipeline/`'s scrapers already used, and removing the now-redundant
local `axios`/`https`/`httpsAgent` setup those files had each been carrying
independently. Verified live against dsebd.org after the change (real closing
prices, live ticker, and one company's audited financials all still parse
correctly through the retry wrapper).

**7. Compound dividend cells silently zeroed cash DPS in bonus years
(found 2026-08-24).** `fundamentals_scraper.js`'s cash-dividend cell parsing
assumed the cell always held a single number. DSE's own page sometimes emits
a compound string when a bonus was also issued that year, e.g.
`"5.00, 5% B"` (5% cash + 5% bonus) — `numOrNull` on the raw compound string
choked on the trailing `", 5% B"` and silently returned `null`, deleting the
cash DPS for every bonus year (a live DSE cross-check found this was
**288/288** of all dps mismatches; 0 in years with no bonus, confirming the
pattern). Fixed by extracting the pre-comma segment before parsing. Live
cross-check re-run against all 389 companies afterward: **1,900/1,900**
`fundamentals_history` fiscal-year rows match live DSE exactly across all 6
disclosed fields (`eps`, `navps`, `dps`, `bonus_pct`, `pe_ratio`,
`dividend_yield`), 0 mismatches, 0 gaps.

**8. A rejected detail field collaterally deactivated a real, actively-traded
symbol (found 2026-08-24).** `company_list_scraper.js` unconditionally resets
every symbol's `is_active` to `0` before re-fetching, then only sets it back
to `1` as part of the same write that also carries name/sector/face
value/etc. When `DataAuditor.auditCompanyListRecord()` rejected a record over
one bad *detail* field (DSE's own page genuinely publishes
`Face/par Value: 0.0` for a handful of debentures), the whole write —
including `is_active` — was skipped via a `continue`, leaving a symbol DSE's
own 30-day traded roster confirmed was actively trading marked inactive in
staging. Fixed with a minimal upsert on the audit-reject path that only ever
touches `is_active`/`fetched_at`, never writes the rejected field, and never
overwrites an existing good detail value. The underlying detail gap this
surfaced (244 symbols, mostly Treasury Bonds whose `displayCompany.php` page
doesn't exist on DSE at all) was backfilled in staging for the 391 symbols
that do have a real DSE detail page; the fix and backfill are staged, not yet
promoted to main DB (promotion requires the explicit human confirmation this
document's promotion gate already requires — see Main DB source policy
above).

## Checklist for adding a new data source, scraper, or field

- [ ] Does every mapping hop (scraper → staging → promotion payload → ingest
      endpoint → SQL params) use `shared/safe_number.js`'s `numOrNull`/
      `deriveOrNull`/`sumTerm`, with no hand-rolled `!== undefined` check, `|| 0`,
      `?? 0`, or `?? otherField` anywhere in the chain?
- [ ] Does the new source have a real, tier-approved label in
      `shared/source_tiers.js` — not a default assumed label, and not a source
      that's never been explicitly reviewed and added there?
- [ ] If the field has a plausible "impossible" value (zero P/E, zero paid-up
      capital, an index below its historical floor), is that value added to
      `db_auditor.js` and/or `shared/data_auditor.js` as a hard error?
- [ ] If a column is `NOT NULL` in the schema, does the write path skip the row
      (with a logged warning) rather than insert a placeholder when the real value
      is unknown?
- [ ] Does the new field belong to a `'Provisional'` row (Job 3's still-forming
      current-period tracking, freely updatable) or an `'Audited'` one
      (promoted, immutable) in `fundamentals_history` — see "Historical data is
      additive-only for AUDITED rows" above?
- [ ] A new scraper: added to `shared/scraper_registry.js` with `enabled: false`,
      gated at its function entry point (not just at one caller — see
      `runJob2IntradaySync` for the pattern when a function has multiple callers),
      and its output audited via `DataAuditor` before the write it feeds?
- [ ] Added a regression case to `shared/test_suite.js` (or pipeline's) covering
      the new field/parsing logic, especially the "value genuinely wasn't
      disclosed" path — that's the path every incident above happened on?
- [ ] Run `npm test && npm run audit:all` after the change and confirm everything
      passes.
