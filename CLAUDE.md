# DSE Pulse Backend

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before touching a scraper, a schema, a
write path, or a data source.** It is the binding architecture and policy
reference for this project, not background reading — every change to those
areas must comply with what it specifies (the tier system, the null-handling
rule, the scraper kill-switch, the audit gates, the historical-data-immutability
rule) and, where relevant, update it (new source → add to
`shared/source_tiers.js` and document it there; new incident → add it to the
Known Incidents section rather than just fixing it silently).

Quick orientation:

- `pipeline/` — CLI-only historical backfill tool (through yesterday), staging
  DB + audit + manual promotion gate. Not a live service.
- `server/` — the live API + today/future data layer. Cron jobs scrape
  directly into `data/dse.db` and the frontend reads from its endpoints.
- `shared/` — the canonical implementations both subsystems import instead of
  reimplementing: `safe_number.js` (null/number handling), `data_auditor.js`
  (validates records before any DB write), `scraper_registry.js` (every
  scraper's kill-switch, off by default), `source_tiers.js` (the approved
  source list), `code_audit.js` / `test_suite.js` (static + regression checks).

Before changing anything in `server/db.js`, `server/index.js`,
`pipeline/src/scrapers/`, `pipeline/src/promotion/`, or any `shared/` file, run:

```bash
npm test && npm run audit:all
```

and confirm it passes before *and* after your change — a regression here means
a fabricated value or a policy violation slipped through, not a style nit.
