/**
 * Master kill-switch for every scraper in this project. Every scraper is OFF by
 * default (`enabled: false`) and must be explicitly flipped here before it will
 * run through ANY invocation path -- cron schedule, CLI flag, or API route. Those
 * call sites check `isScraperEnabled()` and refuse to run otherwise; they don't
 * have their own separate bypass.
 *
 * To bring a scraper live: change its `enabled` value to `true` below, save, and
 * restart the process (server/pipeline scheduler). Nothing else needs to change.
 */

export const SCRAPER_REGISTRY = {
  'pipeline.live_ticker': {
    enabled: false,
    file: 'pipeline/src/scrapers/live_scraper.js',
    description: 'Live market snapshot (prices + breadth) from dsebd.org, every 5 min in trading hours',
    invokedBy: 'pipeline/src/scheduler.js cron (*/5 10-14 * * 0-4)',
    writesTo: 'main DB via publishLiveSnapshot (/api/ingest/live)',
  },
  'pipeline.eod_settlement': {
    enabled: false,
    file: 'pipeline/src/scrapers/live_scraper.js',
    description: 'EOD closing snapshot at 15:30 BST',
    invokedBy: 'pipeline/src/scheduler.js cron (30 15 * * 0-4)',
    writesTo: 'main DB via publishLiveSnapshot (/api/ingest/live)',
  },
  'pipeline.gap_scraper_price': {
    enabled: false,
    file: 'pipeline/src/scrapers/gap_scraper.js (fillPriceGap)',
    description: 'Fills price history gaps from dsebd.org day_end_archive',
    invokedBy: 'pipeline/src/cli.js --scrape-gap, or --resume',
    writesTo: 'stg_price_history (staging DB)',
  },
  'pipeline.gap_scraper_index': {
    enabled: false,
    file: 'pipeline/src/scrapers/gap_scraper.js (fillIndexGap)',
    description: 'Fills DSEX index history gaps from dsebd.org',
    invokedBy: 'pipeline/src/cli.js --scrape-gap, or --resume',
    writesTo: 'stg_index_history (staging DB)',
  },
  'pipeline.fundamentals_scraper': {
    enabled: false,
    file: 'pipeline/src/scrapers/fundamentals_scraper.js',
    description: 'Official audited annual fundamentals disclosures from dsebd.org',
    invokedBy: 'pipeline/src/cli.js --scrape-fundamentals, or --resume',
    writesTo: 'stg_annual_fundamentals (staging DB)',
  },
  'pipeline.company_list_scraper': {
    enabled: false,
    file: 'pipeline/src/scrapers/company_list_scraper.js',
    description: 'Active company list + details from dsebd.org',
    invokedBy: 'pipeline/src/cli.js --fetch-company-list',
    writesTo: 'stg_company_list (staging DB)',
  },
  'pipeline.dse_index_graph': {
    enabled: false,
    file: 'pipeline/src/scrapers/dse_index_graph_scraper.js',
    description: 'Real DSEX history from dsebd.org\'s chart endpoint (Tier 1) -- validates existing Tier 1 rows (never overwrites them) and upgrades Tier 3 (KAGGLE/MCAP_WEIGHTED_ESTIMATE) rows to real data where DSE has it',
    invokedBy: 'manual only -- crossCheckAndUpgradeIndexHistory()',
    writesTo: 'stg_index_history (staging DB), source=DSE_OFFICIAL_GRAPH -- Tier 3 rows only, or previously-missing dates',
  },
  'pipeline.lankabd_scraper': {
    enabled: false,
    file: 'pipeline/src/scrapers/lankabd_scraper.js',
    description: 'Real daily price history from lankabd.com (Tier 2)',
    invokedBy: 'manual only -- fillFromLankaBD()',
    writesTo: 'stg_price_history (staging DB), source=LANKABD',
  },
  'pipeline.external_crosscheck_lankabd': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_lankabd.js',
    description: 'Read-only cross-validation of stg_price_history against lankabd.com (no price/fundamentals writes)',
    invokedBy: 'manual only -- runExternalCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not price/fundamentals data',
  },
  'pipeline.external_crosscheck_dse_prices': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_dse_prices.js',
    description: 'Read-only live cross-validation of stg_price_history against dsebd.org (Tier 1) -- complements external_crosscheck_lankabd.js which checks against Tier 2',
    invokedBy: 'manual only -- runDSEPriceCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not price data',
  },
  'pipeline.external_crosscheck_dse_fundamentals': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_dse_fundamentals.js',
    description: 'Read-only live cross-validation of stg_annual_fundamentals against dsebd.org -- the primary correctness check for this table (LankaBD carries no fundamentals data to check against)',
    invokedBy: 'manual only -- runDSEFundamentalsCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not fundamentals data',
  },
  'pipeline.external_crosscheck_dse_index': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_dse_index.js',
    description: 'Read-only live cross-validation of stg_index_history Tier 1 rows against dsebd.org (reachable window only -- see file header for the coverage limitation)',
    invokedBy: 'manual only -- runDSEIndexCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not index data',
  },
  'pipeline.external_crosscheck_dse_companylist': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_dse_companylist.js',
    description: 'Read-only live cross-validation of stg_company_list against dsebd.org\'s live 30-day traded roster',
    invokedBy: 'manual only -- runDSECompanyListCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not company_list data',
  },
  'server.closing_prices': {
    enabled: false,
    file: 'server/index.js (fetchDSEClosingPrices, runJob1ClosingPrices)',
    description: 'Official daily closing prices from dsebd.org',
    invokedBy: 'server/index.js cron Job 1 (30 15 * * 0-4)',
    writesTo: 'main DB: price_history, dsex_market_history',
  },
  'server.live_ticker': {
    enabled: false,
    file: 'server/index.js (fetchDSELiveTicker, runJob2IntradaySync)',
    description: 'Live intraday ticker snapshot from dsebd.org (session-only, 0 DB writes)',
    invokedBy: 'POST /api/scrape, POST /api/jobs/intraday (on demand, not cron)',
    writesTo: 'none -- returned directly in the API response',
  },
  'server.fundamentals_delta': {
    enabled: false,
    file: 'server/scrapers/audited_eps_scraper.js (via runJob3DailyFundamentalsDelta)',
    description: 'Daily audited EPS + fundamentals delta from dsebd.org',
    invokedBy: 'server/index.js cron Job 3 (0 16 * * 0-4)',
    writesTo: 'main DB: fundamentals_history',
  },
  'server.fundamentals_weekly': {
    enabled: false,
    file: 'server/scrapers/audited_eps_scraper.js (runAuditedEPSWeeklyScraper)',
    description: 'Manual on-demand full-universe audited EPS + financial statements crawl',
    invokedBy: 'manual only -- scripts/scrape_audited_eps.js (its Saturday cron trigger was removed 2026-08-22: confirmed identical to Job 3, pure redundancy)',
    writesTo: 'main DB: fundamentals_history',
  },
};

/**
 * In-memory admin-panel override (added 2026-08-23, see server/admin_routes.js)
 * -- kept as a plain synchronous Map rather than a DB read on every call, since
 * isScraperEnabled() is called from many synchronous contexts across both
 * subsystems and making it async would touch every one of those call sites.
 * The admin panel writes to the `scraper_settings` DB table (the durable
 * record, survives a restart) AND calls setRuntimeOverride in the same
 * server/ process, so a toggle takes effect immediately for that process
 * without needing a restart. server/index.js loads any existing DB rows into
 * this map once at boot. A process that never touches this (any pipeline/
 * process, which doesn't import from server/admin_routes.js) behaves exactly
 * as before -- this is purely additive and does nothing unless something
 * explicitly calls setRuntimeOverride.
 */
const runtimeOverrides = new Map();

export function setRuntimeOverride(key, enabled) {
  runtimeOverrides.set(key, enabled === true);
}

export function clearRuntimeOverride(key) {
  runtimeOverrides.delete(key);
}

export function getRuntimeOverrides() {
  return new Map(runtimeOverrides);
}

/**
 * Returns true only if `key` exists in the registry AND is explicitly enabled.
 * An unknown key is treated as disabled (fail closed, not fail open) and logs a
 * warning -- a typo'd key should never silently let a scraper run. A runtime
 * override (admin panel) takes priority over the file's own `enabled` value
 * when one has been set for this process; otherwise falls through to the
 * file, unchanged from how this always worked.
 */
export function isScraperEnabled(key) {
  const entry = SCRAPER_REGISTRY[key];
  if (!entry) {
    console.warn(`[SCRAPER REGISTRY] Unknown scraper key "${key}" -- treating as disabled.`);
    return false;
  }
  if (runtimeOverrides.has(key)) {
    return runtimeOverrides.get(key);
  }
  return entry.enabled === true;
}

/** Logs a standard "blocked" message and returns the standard blocked result shape. */
export function scraperBlockedMessage(key) {
  const entry = SCRAPER_REGISTRY[key];
  const desc = entry ? entry.description : key;
  return `[SCRAPER REGISTRY] "${key}" (${desc}) is disabled. Enable it in shared/scraper_registry.js to run.`;
}

export function listScrapers() {
  return Object.entries(SCRAPER_REGISTRY).map(([key, v]) => ({ key, ...v }));
}

/**
 * Pairs of scraper keys that must never be enabled at the same time. Both
 * sides of a pair write the same data through the same underlying save path
 * with the same source tier (e.g. server.closing_prices and
 * pipeline.eod_settlement both fire at 15:30 BST and both tag rows Tier 1 --
 * DSE_LIVE_CLOSING / DSE_OFFICIAL). The tier-priority write guard
 * (tierAllowsOverwrite in source_tiers.js) deliberately allows a same-tier
 * overwrite through, since a normal re-scrape of the same source is fine --
 * so it does nothing to stop two independent jobs racing each other and
 * silently overwriting with no warning. This is a real, previously-unfixed
 * risk flagged in ARCHITECTURE.md; enforced here as a hard boot-time check
 * instead of a comment nobody re-reads before flipping a flag.
 */
export const MUTUALLY_EXCLUSIVE_SCRAPER_PAIRS = [
  ['server.closing_prices', 'pipeline.eod_settlement'],
];

/** Throws if any mutually-exclusive pair is enabled together. Call at process boot. */
export function assertNoConflictingScrapers() {
  for (const [a, b] of MUTUALLY_EXCLUSIVE_SCRAPER_PAIRS) {
    if (isScraperEnabled(a) && isScraperEnabled(b)) {
      throw new Error(
        `[SCRAPER REGISTRY] "${a}" and "${b}" are both enabled. They write the same ` +
        `data via the same path and must never run together -- disable one in ` +
        `shared/scraper_registry.js before starting this process.`
      );
    }
  }
}
