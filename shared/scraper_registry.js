/**
 * Master kill-switch for every scraper in this project. Every scraper is OFF by
 * default (`enabled: false`) and must be explicitly flipped here before it will
 * run through ANY invocation path -- cron schedule, CLI flag, or API route. Those
 * call sites check `isScraperEnabled()` and refuse to run otherwise; they don't
 * have their own separate bypass.
 *
 * To bring a scraper live: change its `enabled` value to `true` below, save, and
 * restart the server process. Nothing else needs to change.
 *
 * ARCHITECTURE NOTE (2026-08-29): the legacy staging DB and its separate
 * ingestion workspace are RETIRED. Every scraper here writes directly to main
 * DB (dse.db) via server/db.js's ingestion helpers. Key prefixes below
 * (`historical.`/`auditor.`/`server.`) are category labels only -- every key
 * here runs inside this same process regardless of prefix.
 */

// Every entry below carries the same shape, so the admin dashboard can render
// "what does this scraper actually do" without a separate lookup table:
//   site        -- which live site(s) it fetches from ('none' for the 7
//                  hardcoded PDF benchmark records / internal-only auditors)
//   dataPoints  -- the real fields it extracts, in plain language
//   frequency   -- its real current cadence (cron expression + window, or
//                  how it's actually invoked if not on cron)
export const SCRAPER_REGISTRY = {
  'historical.gap_scraper_price': {
    enabled: false,
    file: 'server/scrapers/scrape_current_gap_filler_operations.js (fillPriceGap)',
    description: 'Current Gap Scraper: Fills price gaps from dsebd.org day_end_archive',
    site: 'dsebd.org',
    dataPoints: 'Per-symbol OHLCV, volume, turnover for any missing trading date',
    frequency: 'Manual CLI or maintenance script -- not on cron',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): price_history, source=DSE_SCRAPE',
  },
  'historical.gap_scraper_index': {
    enabled: false,
    file: 'server/scrapers/scrape_current_gap_filler_operations.js (fillIndexGap)',
    description: 'Current Gap Scraper: Fills index gaps from dsebd.org',
    site: 'dsebd.org',
    dataPoints: 'DSEX / DS30 daily index level for any missing trading date',
    frequency: 'Manual CLI or maintenance script -- not on cron',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): dsex_market_history, ds30_index_history, source=DSE_OFFICIAL_GRAPH',
  },
  'historical.gap_scraper_fundamentals': {
    enabled: false,
    file: 'server/scrapers/scrape_current_gap_filler_operations.js (fillFundamentalsGap)',
    description: 'Current Gap Scraper: Scans active symbols for missing fundamentals & balance sheet history',
    site: 'dsebd.org',
    dataPoints: 'EPS, NAVPS, reserve/OCI/loan balances, dividend history for symbols with 0 or incomplete fundamentals rows',
    frequency: 'Manual CLI or maintenance script -- not on cron',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): fundamentals_history, company_list, source=DSE_OFFICIAL',
  },
  'historical.fundamentals_scraper': {
    enabled: false,
    file: 'server/scrapers/scrape_historical_financial_statements.js (scrapeFundamentalsForAll)',
    description: 'Historical Fundamentals Scraper: Official audited annual fundamentals history disclosures from dsebd.org',
    site: 'dsebd.org',
    dataPoints: 'Multi-year EPS, NAVPS, net income, P/E, dividend yield, DPS, balance sheet (latest year), shareholding pattern',
    frequency: 'Manual CLI (npm run scrape:fundamentals) -- self-enables its own kill-switch on run, not on cron',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): fundamentals_history + shareholding_current, source=DSE_OFFICIAL, audit_status=Audited',
  },
  'historical.lankabd_dividend_archive': {
    enabled: false,
    file: 'server/scrapers/scrape_historical_financial_statements.js (scrapeLankaBDDividendArchive)',
    // Added 2026-09-01 -- this function previously had NO gate at all (no
    // registry key, no isScraperEnabled check), and ran unconditionally on
    // every default CLI invocation of this file, duplicating all ~4,412
    // dividend events on every rerun (17,522 rows found in the live DB
    // against the ~4,412 expected). Now gated like every other scraper.
    description: 'LankaBD Dividend Archive Scraper: multi-year dividend event history (declared/record/AGM dates) from lankabd.com',
    site: 'lankabd.com',
    dataPoints: 'Per-symbol dividend events: cash %, bonus %, publish/record/AGM dates, ~4,412 historical rows',
    frequency: 'Manual CLI (npm run scrape:fundamentals, or --lankabd flag) -- self-enables its own kill-switch on run, matching its sibling historical.fundamentals_scraper',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): corporate_actions_calendar, source=LANKABD',
  },
  'historical.company_list_scraper': {
    enabled: false,
    file: 'server/scrapers/sources/dse_company_roster.js (scrapeCompanyList)',
    description: 'Active company list + details from dsebd.org -- deliberately disabled since 2026-08-23, reason not currently recorded',
    site: 'dsebd.org',
    dataPoints: 'Active symbol discovery (30-day traded roster) + name, sector, category, face value, total shares per company',
    frequency: 'Manual CLI -- not on cron',
    invokedBy: 'CLI or maintenance script',
    writesTo: 'main DB (dse.db): company_list + data/active_symbols.json cache, source=DSE_SCRAPE',
  },
  'historical.dse_index_graph': {
    enabled: false,
    file: 'server/scrapers/scrape_historical_indexes.js (syncHistoricalDSEXGraph / syncAllHistoricalIndexes)',
    description: 'Historical DSEX & DS30 Index Graph Scraper: Real historical DSEX and DS30 chart series from dsebd.org endpoint (Tier 1)',
    site: 'dsebd.org',
    dataPoints: 'Date + index value, up to 200 months (~16.7 years) of DSEX/DS30 history from the chart endpoint',
    frequency: 'Manual CLI (npm run scrape:historical-indexes) -- not on cron',
    invokedBy: 'manual only -- syncHistoricalDSEXGraph() / syncAllHistoricalIndexes()',
    writesTo: 'main DB (dse.db): dsex_market_history, ds30_index_history, source=DSE_OFFICIAL_GRAPH',
  },
  'historical.lankabd_scraper': {
    enabled: false,
    file: 'server/scrapers/scrape_historical_lankabd_prices.js',
    description: 'Historical Secondary Price Scraper: Real daily historical price archive from lankabd.com (Tier 2) -- was completely broken (100% failure, ReferenceError on every row) until fixed 2026-08-31',
    site: 'lankabd.com',
    dataPoints: 'Per-symbol daily OHLCV, volume, turnover, trades count, market cap, ycp, change -- the only scraper that populates price_history.market_cap_mn/trades',
    frequency: 'Manual CLI (npm run scrape:lankabd) -- not on cron; tier guard blocks it from overwriting existing Tier 1 dates, so it only lands on genuinely uncovered dates',
    invokedBy: 'manual only -- fillFromLankaBD()',
    writesTo: 'main DB (dse.db): price_history, source=LANKABD',
  },
  'historical.block_market_scraper': {
    enabled: false,
    file: 'server/scrapers/scrape_current_block_market.js',
    description: 'Block Market Transactions Scraper: Real daily block market volume, value, trades, and min/max prices from lankabd.com (Tier Two)',
    site: 'lankabd.com',
    dataPoints: 'Per-symbol institutional block trades: quantity, turnover value, trade count, max/min execution price',
    frequency: 'Cron -- rides server/cron_scheduler.js\'s unified post-market cycle (Step 3.5, every 30 min Sun-Thu 14:30-18:00 BST), added 2026-08-31',
    invokedBy: 'server/cron_scheduler.js post-market cycle, or manual CLI -- scrapeBlockMarket()',
    writesTo: 'main DB (dse.db): block_market_history, source=LANKABD',
  },
  'auditor.external_crosscheck_block_market': {
    enabled: false,
    file: 'server/auditors/audit_block_market.js',
    // Corrected 2026-09-01: this does NOT hit lankabd.com despite the key name
    // and its own prior description -- it's an internal consistency check only
    // (min_price<=max_price, quantity>0, value_mn>0, approved-source) over rows
    // already in block_market_history. No live fetch exists in the code.
    description: 'Block Market Internal Consistency Auditor: validates existing block_market_history rows (no live re-fetch)',
    site: 'none -- internal DB check only, no live fetch performed',
    dataPoints: 'Validates existing block_market_history rows (min/max price ordering, positive quantity/value, approved source); does not compare against a fresh lankabd.com fetch',
    frequency: 'Manual only -- not on cron',
    invokedBy: 'manual only -- runBlockMarketCrossCheck()',
    writesTo: 'audit_reports, no block market data writes',
  },
  'auditor.external_crosscheck_credit_ratings': {
    enabled: false,
    file: 'server/auditors/audit_credit_ratings.js',
    description: 'Credit Ratings Cross-Check Auditor: Read-only validation of credit_ratings table -- no scraper currently populates this table going forward, it holds a one-time historical backfill only',
    site: 'internal (own DB) -- no scraper feeds this table',
    dataPoints: 'Validates existing credit_ratings rows only; does not discover new ratings',
    frequency: 'Manual only -- not on cron',
    invokedBy: 'manual only -- runCreditRatingsCrossCheck()',
    writesTo: 'audit_reports, no credit rating writes',
  },
  'auditor.external_crosscheck_share_lockins': {
    enabled: false,
    file: 'server/auditors/audit_share_lockins.js',
    description: 'Share Lock-in Details Auditor: Read-only validation of share_lockins table -- same one-time-backfill-only situation as credit_ratings',
    site: 'internal (own DB) -- no scraper feeds this table',
    dataPoints: 'Validates existing share_lockins rows only; does not discover new lock-ins',
    frequency: 'Manual only -- not on cron',
    invokedBy: 'manual only -- runShareLockinsCrossCheck()',
    writesTo: 'audit_reports, no lock-in writes',
  },
  'historical.pdf_financial_scraper': {
    enabled: false,
    file: 'server/scrapers/scrape_pdf_financial_statements.js',
    description: 'PDF Financial Statements Harvester -- see ARCHITECTURE.md Known Incident #9: an earlier version fabricated ~2,153 rows instead of parsing real PDFs. Now contains only 7 manually-verified real benchmark records; real PDF fetch-and-parse is unbuilt (see docs/PDF_INGESTION_PLAN.md)',
    site: 'none -- 7 hardcoded real benchmark records, no live fetch',
    dataPoints: 'Revenue, gross/operating profit, total assets/liabilities, current assets/liabilities, capex, operating & free cash flow -- for GP, BATBC, SQURPHARMA, BRACBANK, WALTONHIL, RENATA only',
    frequency: 'Manual CLI only -- not on cron, and not a real scrape (no PDF fetch exists yet)',
    invokedBy: 'manual only -- scrapePdfFinancialStatements()',
    writesTo: 'main DB (dse.db): fundamentals_history, source=PDF_AUDITED_ANNUAL_REPORT',
  },
  'auditor.external_crosscheck_pdf_statements': {
    enabled: false,
    file: 'server/auditors/audit_pdf_financial_statements.js',
    description: 'Audited PDF Statements Cross-Check Auditor: Read-only validation of PDF-ingested statement line items in fundamentals_history',
    site: 'internal (own DB, read-only)',
    dataPoints: 'Validates accounting identities on existing PDF-sourced rows',
    frequency: 'Manual only -- not on cron',
    invokedBy: 'manual only -- runPdfStatementsCrossCheck()',
    writesTo: 'audit_reports, no fundamental writes',
  },
  'auditor.external_crosscheck_lankabd': {
    enabled: false,
    file: 'server/auditors/audit_historical_prices_lankabd.js',
    description: 'Historical Price Cross-Check Audit: Read-only cross-validation of historical price_history against lankabd.com',
    site: 'lankabd.com (read-only)',
    dataPoints: 'Compares stored price_history rows against a fresh live fetch per symbol',
    frequency: 'Manual only -- not on cron, hits a live external site (slow, run per batch of symbols)',
    invokedBy: 'manual only -- runExternalCrossCheck()',
    writesTo: 'audit_reports + CSV report, no price data writes',
  },
  'auditor.external_crosscheck_dse_prices': {
    enabled: false,
    file: 'server/auditors/audit_historical_prices_dse.js',
    description: 'Historical Price Cross-Check Audit: Read-only live cross-validation of historical price_history against dsebd.org (Tier 1)',
    site: 'dsebd.org (read-only)',
    dataPoints: 'Compares stored price_history rows against dsebd.org day_end_archive per symbol',
    frequency: 'Manual only -- not on cron, hits a live external site',
    invokedBy: 'manual only -- runDSEPriceCrossCheck()',
    writesTo: 'audit_reports + CSV report, no price data writes',
  },
  'auditor.external_crosscheck_dse_fundamentals': {
    enabled: false,
    file: 'server/auditors/audit_historical_fundamentals_dse.js',
    description: 'Historical Fundamentals Cross-Check Audit: Read-only live cross-validation of historical fundamentals_history against dsebd.org',
    site: 'dsebd.org (read-only)',
    dataPoints: 'Compares stored EPS/NAVPS/DPS/etc. against a fresh displayCompany.php fetch per symbol',
    frequency: 'Manual only -- not on cron, hits a live external site',
    invokedBy: 'manual only -- runDSEFundamentalsCrossCheck()',
    writesTo: 'audit_reports + CSV report, no fundamentals writes',
  },
  'auditor.external_crosscheck_dse_index': {
    enabled: false,
    file: 'server/auditors/audit_historical_dsex_index.js',
    description: 'Historical Index Cross-Check Audit: Read-only live cross-validation of historical dsex_market_history Tier 1 rows against dsebd.org',
    site: 'dsebd.org (read-only)',
    dataPoints: 'Compares stored DSEX index values against the live chart endpoint',
    frequency: 'Manual only -- not on cron, hits a live external site',
    invokedBy: 'manual only -- runDSEIndexCrossCheck()',
    writesTo: 'audit_reports + CSV report, no index data writes',
  },
  'auditor.external_crosscheck_dse_companylist': {
    enabled: false,
    file: 'server/auditors/audit_company_roster_dse.js',
    description: 'Read-only live cross-validation of company_list against dsebd.org\'s live 30-day traded roster',
    site: 'dsebd.org (read-only)',
    dataPoints: 'Compares the stored active-symbol roster against a fresh 30-day traded-instrument fetch',
    frequency: 'Manual only -- not on cron, hits a live external site',
    invokedBy: 'manual only -- runDSECompanyListCrossCheck()',
    writesTo: 'audit_reports + CSV report, no company_list writes',
  },
  'server.closing_prices': {
    enabled: false,
    file: 'server/scrapers/sources/dse_closing_scraper.js (runDailyClosingPricesScraper)',
    description: 'Official daily closing prices + DSEX settlement from dsebd.org (Job 1)',
    site: 'dsebd.org',
    dataPoints: 'Per-symbol close, ycp, volume; DSEX index, advancing/declining/unchanged, total trades/volume/value',
    frequency: 'Cron -- server/cron_scheduler.js unified post-market cycle, every 30 min Sun-Thu 14:30-18:00 BST',
    invokedBy: 'server/cron_scheduler.js post-market cycle (Job 1)',
    writesTo: 'main DB: price_history, dsex_market_history',
  },
  'server.live_ticker': {
    enabled: false,
    file: 'server/scrapers/scrape_live_intraday_ticker.js (runLiveIntradayTickerScraper)',
    description: 'Live intraday ticker snapshot from dsebd.org (session-only, 0 DB writes) -- not actually part of the automatic post-market cycle despite its own status descriptor implying it',
    site: 'dsebd.org',
    dataPoints: 'Per-symbol live LTP, change, change% -- merged in-memory onto the DB snapshot, never persisted',
    frequency: 'On-demand only -- POST /api/scrape or /api/jobs/intraday (admin-gated), not on cron',
    invokedBy: 'POST /api/scrape, POST /api/jobs/intraday (on demand, not cron)',
    writesTo: 'none -- returned directly in the API response',
  },
  'server.fundamentals_delta': {
    enabled: false,
    file: 'server/scrapers/sources/dse_fundamentals_scraper.js (runDailyFundamentalsDeltaScraper)',
    description: 'Daily audited EPS + fundamentals delta from dsebd.org (Job 3)',
    site: 'dsebd.org',
    dataPoints: 'Per-symbol EPS, NAVPS, ROE, dividend yield, P/E, net income, reserve/OCI/loan balances, DPS, bonus %, shareholding pattern',
    frequency: 'Cron -- rides the same post-market cycle as Job 1, only actually runs once Job 1 confirms today\'s closing data is in',
    invokedBy: 'server/cron_scheduler.js post-market cycle (Job 3)',
    writesTo: 'main DB: fundamentals_history, shareholding_current',
  },
  'server.fundamentals_weekly': {
    enabled: false,
    file: 'server/scrapers/sources/dse_fundamentals_scraper.js (runAuditedEPSWeeklyScraper)',
    description: 'Manual on-demand full-universe audited EPS + financial statements crawl -- same underlying function as Job 3, different concurrency, no other functional difference found',
    site: 'dsebd.org',
    dataPoints: 'Same fields as server.fundamentals_delta, run against the full symbol universe instead of a daily delta',
    frequency: 'Manual CLI (node server/scrapers/scrape_current_daily_operations.js --eps) -- not on its own cron',
    invokedBy: 'manual only -- node server/scrapers/scrape_current_daily_operations.js --eps',
    writesTo: 'main DB: fundamentals_history',
  },
  'server.ds30_membership': {
    enabled: false,
    file: 'server/scrapers/sources/ds30_index_scraper.js (scrapeDS30Membership)',
    description: 'DS30 blue-chip index membership (30 constituent trading codes) from dsebd.org/dse30_share.php',
    site: 'dsebd.org',
    dataPoints: '30 trading-code symbols -- membership list only, no price data. Flags existing company_list rows, never inserts new ones',
    frequency: 'Manual CLI -- not on cron (membership only changes on a periodic DSE reconstitution, not daily)',
    invokedBy: 'manual only -- node server/scrapers/scrape_current_daily_operations.js --ds30',
    writesTo: 'main DB: company_list.ds30 (flags existing rows only, never inserts new company_list rows)',
  },
  'server.macro_indicators': {
    enabled: false,
    file: 'server/scrapers/scrape_macro_indicators.js (scrapeMacroIndicators)',
    description: 'Weekly macro benchmark scraper: 364-day T-bill Rf, repo rate, CPI-derived terminal growth, empirical DSEX ERP',
    site: 'lankabd.com + internal (empirical ERP computed from own DB)',
    dataPoints: '364-day T-bill yield (was silently hardcoded, never actually scraped, until fixed 2026-08-31), repo rate, CPI-derived terminal growth, empirical equity risk premium from median market P/E + dividend yield',
    frequency: 'Cron -- server/cron_scheduler.js weekly, Thursday 09:00 BST. Added to the kill-switch registry 2026-08-31 -- previously the only scraper in the project with no gate at all',
    invokedBy: 'server/cron_scheduler.js weekly cron',
    writesTo: 'main DB: macro_indicators',
  },
  'server.ds30_index': {
    enabled: false,
    file: 'server/scrapers/sources/ds30_index_scraper.js (scrapeDs30IndexLevel, via runDailyClosingPricesScraper)',
    description: 'Real DS30 index level (+ derived day-over-day change) from dsebd.org\'s chart endpoint -- distinct from server.ds30_membership, which is a per-stock boolean flag, not an index value',
    site: 'dsebd.org',
    dataPoints: 'Date + DS30 index value, derived day-over-day change %',
    frequency: 'Cron -- rides Job 1\'s post-market cycle when enabled',
    invokedBy: 'server/cron_scheduler.js post-market cycle (Job 1)',
    writesTo: 'main DB: ds30_index_history',
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
 * this map once at boot. A process that never imports server/admin_routes.js
 * behaves exactly as before -- this is purely additive and does nothing unless something
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
 * Pairs of scraper keys that must never be enabled at the same time -- both
 * would write the same data through the same underlying save path with the
 * same source tier, and the tier-priority write guard (tierAllowsOverwrite in
 * source_tiers.js) deliberately allows a same-tier overwrite through (a
 * normal re-scrape of the same source is fine), so it does nothing to stop
 * two independent jobs racing each other and silently overwriting with no
 * warning. Currently empty -- no such conflicting pair exists in the current
 * single-process architecture. Kept as infrastructure, enforced as a hard
 * boot-time check, for if one arises (e.g. two scrapers independently added
 * later that happen to target the same table/tier/schedule).
 */
export const MUTUALLY_EXCLUSIVE_SCRAPER_PAIRS = [];

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
