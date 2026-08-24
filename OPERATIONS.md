# DSE Pulse — Operations Runbook

Procedure, not policy — for *why* a rule exists, see `ARCHITECTURE.md`. This
document only covers: which scrapers to enable, in what order, which pairs
must never run together, and how to verify a change didn't break anything
before walking away from the terminal.

## Deployment scope: `pipeline/` never ships to production

Only `server/` runs in production. `pipeline/` is a local/dev-only CLI
toolkit — no `pipeline/` process, cron, or CLI command should ever be started
on a production host or in a production deployment config. It exists to
backfill history through yesterday, one-off, run by a human who reviews the
`npm run pipeline:audit` output before promoting. Once a symbol/date range is
backfilled and promoted, there's nothing left for `pipeline/` to do in that
environment until the next gap needs filling — it isn't a service that stays
running. Because of this split, `server/`'s own scrapers carry the full
reliability bar (retry/backoff, no silent fallback values) on their own —
see incident #6 in `ARCHITECTURE.md`'s Known Incidents.

## The one hard rule

**Never enable `server.closing_prices` and `pipeline.eod_settlement` at the
same time.** Both fire at 15:30 BST, both write the identical closing-price
data via the identical path, both tag it Tier 1 — so if both run, whichever
finishes last silently wins with no warning. This is no longer just a
documented risk: both `server/index.js` and `pipeline/src/scheduler.js` call
`assertNoConflictingScrapers()` at boot and will refuse to start (crash with a
clear error) if you violate this. If you hit that crash, it means you (or
someone) flipped both flags on in `shared/scraper_registry.js` — disable one.

In the target architecture, `server/` owns *today* and `pipeline/` owns
*history through yesterday*. `pipeline.eod_settlement` and
`pipeline.live_ticker` only exist because that split isn't fully retired yet
(see `ARCHITECTURE.md`'s "Known architectural mismatch" note). Until that
retirement happens, treat `server.closing_prices` as the *only* correct one to
ever enable for live daily closing prices — leave `pipeline.eod_settlement`
off.

## Safe scraper-enable order

All scrapers default `enabled: false` in `shared/scraper_registry.js`. Bringing
one live is a one-line edit there, followed by a process restart (no hot
reload — an already-running process keeps whatever code and registry state it
started with).

**Historical backfill (`pipeline/`, one-time or occasional, not continuous):**

1. `pipeline.company_list_scraper` first — every other pipeline scraper reads
   the symbol roster this produces from `stg_company_list`.
2. `pipeline.gap_scraper_price` and `pipeline.gap_scraper_index` next, in
   either order — independent of each other.
3. `pipeline.lankabd_scraper` only as a *repair* pass for symbols DSE's own
   archive can't fill (Tier 2, used to backstop Tier 1, never to replace it
   preemptively). Run DSE-sourced scraping (`gap_scraper_price`) first, then
   LankaBD only for what's still missing — the tier-priority guard
   (`tierAllowsOverwrite` in `shared/source_tiers.js`) will block a Tier 2 row
   from clobbering an existing Tier 1 row, but running DSE second wastes a
   full re-scrape rather than filling only the gap.
4. `pipeline.fundamentals_scraper` any time after step 1 (needs
   `stg_company_list` populated for `total_shares`/`face_value`, not price
   history).
5. `pipeline.external_crosscheck_lankabd` is read-only — safe to run any time,
   doesn't touch price/fundamentals data, only writes `audit_reports`.
6. Promote with `pipeline/src/promotion/manual_promoter.js --promote-main
   --confirm` only after `npm run pipeline:audit` reports `CERTIFIED_PASSED`.

**Enable exactly one at a time** during backfill work — running two pipeline
scrapers concurrently isn't blocked by the registry (only the one hardcoded
pair above is), but hasn't been tested for write contention on
`pipeline/data/staging.db` and isn't the pattern this system was built around.

**Live/daily (`server/`, ongoing):**

- `server.closing_prices` (Job 1, 15:30 BST) — the one correct source for
  daily closing prices. Never paired with `pipeline.eod_settlement` (enforced
  at boot, see above).
- `server.fundamentals_delta` (Job 3, daily 16:00 BST) is the only automatic
  fundamentals job now — enable this for ongoing operation.
  `server.fundamentals_weekly` no longer has a cron trigger (removed
  2026-08-22, see `ARCHITECTURE.md`); it's manual-only via
  `node scripts/scrape_audited_eps.js`, for a one-off full-universe
  re-scrape distinct from Job 3's daily delta.
- `server.live_ticker` (Job 2) is on-demand only (`POST /api/scrape`,
  `POST /api/jobs/intraday`) — no cron, writes nothing to the DB, safe to
  enable independently of everything else.

## Restart procedure

1. Edit `shared/scraper_registry.js`, flip exactly the flags you mean to
   change.
2. `npm test` — confirms the registry, tier guard, and null-handling
   invariants still hold. Expect "not a single scraper is enabled by default"
   to fail *only* for the duration you deliberately have something on; revert
   before considering the change done.
3. Restart the process(es) whose registry entries you changed — a running
   `node server/index.js` or `node pipeline/src/scheduler.js` does not pick up
   the edit until restarted.
4. Watch the boot log for `[SCRAPER REGISTRY]` lines confirming the intended
   scrapers are live and nothing unintended is. If you tripped the mutual-
   exclusion guard, the process exits immediately with a clear error — that's
   working as intended, not a bug to work around.
5. `GET /api/jobs/status` (server) or the scheduler's own startup banner
   (pipeline) to confirm cron registration matches what you expect.
6. When done testing a scraper, set it back to `enabled: false` and restart
   again — don't leave a one-off test flag on in committed config.

## Checking system health

```bash
npm test                  # shared/ invariants (safe_number, tier guard, registry, parsing)
npm run audit:all         # code patterns + pipeline staging audit + main-DB audit
node -e "import('./shared/scraper_registry.js').then(m => console.table(m.listScrapers()))"
curl -s http://localhost:5001/api/jobs/status | node -e "process.stdin.pipe(require('fs').createWriteStream('/dev/stdout'))"
```

`GET /api/jobs/status` includes `cronAvailable` (false means `node-cron`
failed to import at boot — zero jobs scheduled, previously silent) and each
job's own status/last-run.

## DB backups

Backups are ad hoc, not triggered by any code path (`grep` confirms nothing in
`server/` or `pipeline/src/` creates a `.bak-*` file automatically) — they're
manual pre-change safety nets, taken by hand before a risky operation. Use
`scripts/backup_db.sh <path-to-db> <label> [keep_count]`, e.g.:

```bash
scripts/backup_db.sh data/dse.db prepromote
scripts/backup_db.sh pipeline/data/staging.db pre244backfill 5
```

This uses `sqlite3 .backup` (safe under WAL mode, unlike a plain `cp` which can
miss data still sitting in the `-wal` sidecar file), gzips the result, and
prunes that DB's own backups down to the newest `keep_count` (default 5)
automatically — fixing the previously-flagged "no cleanup logic" gap. 11
manually-created, uncompressed backups from 2026-08-22 (2.5GB) were compressed
in place that day (672MB, zero data loss, nothing deleted) as the one-time
catch-up; going forward, use the script instead of a bare `cp`.

## Known operational gaps (not yet fixed, flagged for later)

- **`pipeline.live_ticker` / `pipeline.eod_settlement` retirement** — proposed
  in `ARCHITECTURE.md`, not yet executed. Once `server/`'s live path is
  trusted as the sole daily/live writer, these two pipeline cron jobs should
  be deleted outright, not just left disabled.
- **`server.fundamentals_delta` / `server.fundamentals_weekly` redundancy** —
  same scraper, same universe, no found functional difference. Consolidate or
  document the intended distinction.
