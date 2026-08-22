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
  'pipeline.external_crosscheck_lankabd': {
    enabled: false,
    file: 'pipeline/src/audit/external_crosscheck_lankabd.js',
    description: 'Read-only cross-validation of stg_price_history against lankabd.com (no price/fundamentals writes)',
    invokedBy: 'manual only -- runExternalCrossCheck()',
    writesTo: 'audit_reports (staging DB) + a CSV report, not price/fundamentals data',
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
    writesTo: 'main DB: company_fundamentals, fundamentals_history',
  },
  'server.fundamentals_weekly': {
    enabled: false,
    file: 'server/scrapers/audited_eps_scraper.js (runAuditedEPSWeeklyScraper)',
    description: 'Weekly full-universe audited EPS + financial statements crawl',
    invokedBy: 'server/index.js cron (0 10 * * 6, Saturday)',
    writesTo: 'main DB: company_fundamentals, fundamentals_history',
  },
  'server.market_breadth': {
    enabled: false,
    file: 'server/index.js (fetchMarketBreadthFromDSE, runJob4MarketBreadth)',
    description: 'Market breadth (advancing/declining/unchanged) from dsebd.org, every 30 min in trading hours',
    invokedBy: 'server/index.js cron Job 4 (*/30 10-15 * * 0-4)',
    writesTo: 'main DB: intraday_breadth_snapshot',
  },
};

/**
 * Returns true only if `key` exists in the registry AND is explicitly enabled.
 * An unknown key is treated as disabled (fail closed, not fail open) and logs a
 * warning -- a typo'd key should never silently let a scraper run.
 */
export function isScraperEnabled(key) {
  const entry = SCRAPER_REGISTRY[key];
  if (!entry) {
    console.warn(`[SCRAPER REGISTRY] Unknown scraper key "${key}" -- treating as disabled.`);
    return false;
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
