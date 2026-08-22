# DSE Pulse — Data Integrity Audit Rules

## Core principle

Every value this system stores or serves must trace to one of two things:

1. **A real, disclosed number from a Tier 1 (DSE official) or Tier 2 (LankaBangla) source.**
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
| A market-cap-weighted index reconstruction from real per-company data, labeled `MCAP_WEIGHTED_ESTIMATE` | Any of the above presented as `DSE_OFFICIAL` or `'Audited'` without actually being sourced that way |

The dividing line isn't "was a formula involved" — it's whether every input to that
formula is itself real. A derived value from real inputs is fine even if unusual
(e.g. an ROE of 40% is jarring but correct if eps/navps are both real). A plausible
number from no real input is never fine, no matter how realistic it looks.

## Null-handling standard — one implementation, not a convention

This used to be a set of rules re-derived (and re-gotten-slightly-wrong) by hand at
every call site — which is exactly how the same bug class kept recurring under
different disguises (see the three incidents below). It is now a single shared
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
  site — the hand-rolled version is exactly what went wrong three separate times
  (see incidents below): easy to write as `field !== undefined ? ... : null`
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
- `!== undefined` is *not* a null check. `null !== undefined` is `true` in
  JavaScript, so `field !== undefined ? Number(field) : fallback` still lets a real
  `null` fall through into `Number(null)` → `0`. This is exactly what `numOrNull`
  exists to make impossible to get wrong again.

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
  every other hop is correct — see the `fundamentals_history` incident below).
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
- Every staged/promoted record carries a real source label (`DSE_OFFICIAL_ARCHIVE`,
  `DSE_OFFICIAL_BENCHMARK`, `LANKABANGLA`, `MENDELEY`/`KAGGLE`,
  `MCAP_WEIGHTED_ESTIMATE`, etc.) — never a default like `'DSE_OFFICIAL'` applied to
  data whose actual provenance wasn't confirmed.

#### Scraper inventory (`shared/scraper_registry.js`)

| Key | What it scrapes | Writes to |
|---|---|---|
| `pipeline.live_ticker` | Live DSE snapshot, every 5 min in trading hours | main DB (via `/api/ingest/live`) |
| `pipeline.eod_settlement` | EOD closing snapshot, 15:30 BST | main DB (via `/api/ingest/live`) |
| `pipeline.gap_scraper_price` | Price history gap-fill | `stg_price_history` |
| `pipeline.gap_scraper_index` | DSEX index gap-fill | `stg_index_history` |
| `pipeline.fundamentals_scraper` | Official audited annual fundamentals | `stg_annual_fundamentals` |
| `pipeline.company_list_scraper` | Active company list + details | `stg_company_list` |
| `pipeline.external_crosscheck_lankabd` | Read-only cross-validation vs. lankabd.com | `audit_reports` + a CSV, no price/fundamentals data |
| `server.closing_prices` | Official daily closing prices (Job 1) | `price_history`, `dsex_market_history` |
| `server.live_ticker` | Live intraday ticker (Job 2, on-demand only) | none — session-only API response |
| `server.fundamentals_delta` | Daily audited EPS delta (Job 3) | `company_fundamentals`, `fundamentals_history` |
| `server.fundamentals_weekly` | Weekly full-universe audited EPS crawl | `company_fundamentals`, `fundamentals_history` |
| `server.market_breadth` | Market breadth (Job 4) | `intraday_breadth_snapshot` |

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
- Statistical warnings (reported, not blocking — needs a human glance since some are
  legitimately real): EPS outside -200 to 1000, NAVPS ≤ 0, P/E outside 0–300.
- Every row should be traceable to a staging promotion (`manual_promoter.js` via
  `--promote-main --confirm`) or one of the two legitimate live cron jobs (Job 1
  closing prices, Job 4 market breadth) — never a direct write from a standalone
  script outside that path.
- Job 1, Job 3, Job 4, and the weekly audited-EPS crawler now each run their
  scraped output through `DataAuditor` (`shared/data_auditor.js`) before their
  respective `save*` call — this used to be true only of the two remaining
  pipeline cron jobs; none of server/index.js's direct-to-main-DB writers had any
  gate at all before. A blocked write is logged and the job's status reflects it
  (`jobStatusRegistry`) rather than failing silently.
- Run `npm run audit:main-db` to check current state (`server/audit/db_auditor.js`).
  This is a read-only report on what's already landed — it complements the
  write-time gates above, it doesn't replace them; it's how drift from a bug in
  the gate itself, or a write that predates it, gets caught after the fact.

### 4. Pipeline Staging DB data (`pipeline/data/staging.db`)

- Already enforced: `shared/data_auditor.js` (used to live at
  `pipeline/src/audit/auditor.js` — moved so `server/` could import the exact same
  validator instead of needing its own copy or none at all) + `audit_runner.js`
  gate every promotion behind a `CERTIFIED_PASSED` result (0 blocking errors).
  This is the mandatory checkpoint — nothing should reach the main DB through
  `manual_promoter.js` without passing it first. Each staging scraper additionally
  self-audits before its own stage-write (see Scrapers above) — this is now two
  gates, not one: per-scrape at staging time, and per-promotion at main-DB time.
- Same range/null rules as Main DB data above (staging is audited with the same
  thresholds so a certified promotion doesn't need re-deriving separately).
- Run `npm run pipeline:audit` to check current state.

## How to run the audits

```bash
npm test                  # shared/, plus the highest-risk scraper parsing logic
npm run pipeline:audit    # Pipeline Staging DB — gates promotion
npm run audit:main-db     # Main DB (data/dse.db) — data-level, read-only report
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

`npm test` (`shared/test_suite.js`) covers `safe_number.js` (all 5 helpers),
`data_auditor.js` (all 5 audit methods, one regression case per incident below),
`scraper_registry.js` (asserts every scraper defaults off), and the highest-risk
pure parsing logic pulled out of the scrapers for direct testing without a live
HTTP round-trip — `fundamentals_scraper.js`'s multi-group table resolution
(`lastNumberInGroup`/`headlineOrContinuing`), the most intricate parsing in the
codebase and the one most likely to silently misread a layout change.

## Known incident: `fundamentals_history` (2026-08-22)

`server/index.js`'s `/api/ingest/fundamentals` handler wrote each field as
`s.field !== undefined ? Number(s.field) : null` — which fails to catch `null`
(`Number(null)` is `0`), so every genuinely-undisclosed P/E or paid-up-capital sent
by the promotion pipeline was silently stored as a fabricated `0`. `db_auditor.js`'s
first-ever run caught this live: 532 rows with `pe_ratio = 0`, 1,610 rows with
`paid_up_capital_mn = 0`, both counts matching staging's real null-counts for the
same fields exactly. Fixed in the ingest handler (explicit `!== null` check added to
all 8 fields in that INSERT), and the existing corrupted rows were corrected in place
from staging's known-good values. This is the reference example for why `!==
undefined` alone is not a valid null check, and why a runnable Main DB audit matters
even with a staging gate already in place — the gate only certifies what staging
*sends*, not what the ingest endpoint actually *does* with it.

## Known incident: `ycp` defaulted to a same-day price field, three times (2026-08-22)

The specific historical bug this project keeps naming as the canonical example —
`ycp` (yesterday's close) silently defaulting to a same-day price field, fabricating
a 0% change — turned out to have three independent live instances, not one:

1. `pipeline/src/promotion/manual_promoter.js`: `ycp: r.ycp ?? r.close` (found and
   fixed earlier this session).
2. `pipeline/src/scrapers/live_scraper.js`: `const ycp = parseFloat(cols[6]...) ||
   ltp;` — same bug, `||` instead of `??`, `ltp` instead of `close`.
3. `server/index.js`'s `runJob2IntradaySync()`: `(base.ycp || liveLtp)` as the last
   tier of a 3-way fallback chain, plus a second occurrence a few lines later in
   the same function's circuit-breaker branch (`ycp = liveLtp; change = 0;
   changePercent = 0;`) when an anomalous reading had no real value to correct it
   against.

`shared/code_audit.js`'s error pattern for this originally only matched `??` and
only `close` as the fallback target — instance #1's exact shape, nothing else. It
missed #2 and #3 entirely until the pattern was broadened to match both `??` and
`||`, and both `close` and `ltp` as fallback targets. The lesson: a pattern written
to match one incident's exact syntax catches that incident and stops looking: this
one shape recurred three times across two subsystems with two different operators
and two different fallback field names. When fixing a found instance of a bug
class, check whether the *detection* pattern is scoped to the instance or the
class before considering it closed.

## Known incident: the same `!== undefined` bug, three more places, one function family (2026-08-22)

Broadening `code_audit.js`'s coverage to `shared/` and adding a warning for
hand-rolled `!== undefined`-without-`!== null` checks (prompted by the
`fundamentals_history` incident above) immediately found the identical pattern in
**`server/db.js`'s `saveFundamentals()` and `saveFundamentalsBulkDelta()`** —
12 fields each (`eps_basic`, `eps_diluted`, `eps_quarterly`, `nav_per_share`,
`paid_up_capital_mn`, `authorized_capital_mn`, `pe_basic`, `pe_diluted`,
`pe_trailing`, `dividend_yield`, `debt_to_equity`, `current_ratio`), written to
`company_fundamentals` — the live current-snapshot table every stock listing
reads from, not a side table. A direct query confirmed the *current* 395 rows
happened to be clean (0 fabricated zeros across every field), but the bug was
live and would have fired the next time any scraper genuinely found one of these
fields undisclosed. Fixed by routing every field through `numOrNull()`. The
delta-comparison logic feeding the same two functions had a smaller companion bug
— `Number(existing) !== Number(new)` also coerces a `null` "new" value through
`Number(null)` → `0` before comparing, which could both mis-flag and mis-skip an
update; replaced with an explicit `valueChanged()` helper that treats `null`
directly instead of coercing it through `Number()`.

The same sweep also caught a third, subtler live instance of the ycp/change
fabrication bug in `runJob2IntradaySync()`'s circuit-breaker branch:
`live.change !== undefined && !isNaN(live.change)` looks like it guards against a
missing value, but `isNaN(null)` is `false` in JavaScript (`null` coerces to `0`
for the check) — so a `null` `live.change` passed straight through to
`Number(live.change)` → `0` anyway. Fixed by adding the missing `!== null`.

Three unrelated call sites, three slightly different disguises
(`!== undefined` alone; `!== undefined` combined with `isNaN`; the original
ternary-with-`??`), all the same root defect. This is the concrete case for why
`numOrNull()` exists as a single shared implementation rather than a documented
convention: a convention has to be correctly reproduced by hand every time; a
shared function only has to be correct once.

## Checklist for adding a new data source, scraper, or field

- [ ] Does every mapping hop (scraper → staging → promotion payload → ingest
      endpoint → SQL params) use `shared/safe_number.js`'s `numOrNull`/
      `deriveOrNull`/`sumTerm`, with no hand-rolled `!== undefined` check, `|| 0`,
      `?? 0`, or `?? otherField` anywhere in the chain?
- [ ] Does the new source have a real tier label, not a default assumed label?
- [ ] If the field has a plausible "impossible" value (zero P/E, zero paid-up
      capital, an index below its historical floor), is that value added to
      `db_auditor.js` and/or `shared/data_auditor.js` as a hard error?
- [ ] If a column is `NOT NULL` in the schema, does the write path skip the row
      (with a logged warning) rather than insert a placeholder when the real value
      is unknown?
- [ ] A new scraper: added to `shared/scraper_registry.js` with `enabled: false`,
      gated at its function entry point (not just at one caller — see
      `runJob2IntradaySync` for the pattern when a function has multiple callers),
      and its output audited via `DataAuditor` before the write it feeds?
- [ ] Added a regression case to `shared/test_suite.js` (or pipeline's) covering
      the new field/parsing logic, especially the "value genuinely wasn't
      disclosed" path — that's the path every incident above happened on?
- [ ] Run `npm test && npm run audit:all` after the change and confirm everything
      passes.
