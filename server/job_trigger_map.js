/**
 * Single source of truth mapping every shared/scraper_registry.js key to an
 * on-demand "Run Now" function, for the admin panel's fleet control center.
 * Consumed by server/index.js (passed into createAdminRouter as `jobTriggers`)
 * and served by the existing POST /api/admin/jobs/:jobKey/trigger route --
 * no new route, just a bigger map, so the admin panel's manual triggers and
 * the cron scheduler's automatic ones share one telemetry write site per key
 * (see server/db/job_status_repo.js) instead of two.
 *
 * The five cron-driven keys (closing/live_ticker/fundamentals_delta/
 * block_market/macro_indicators) reuse cron_scheduler.js's own tracked
 * exports, so a manual "Run Now" click runs the exact same wrapped code path
 * the scheduler uses -- not a second copy of the tracking logic. The other
 * twenty are wrapped here, once each, since cron_scheduler.js has no reason
 * to import them.
 *
 * Every function below already self-gates on its own registry key (checks
 * isScraperEnabled(key) at its own top and returns { blocked: true } rather
 * than running) -- confirmed for each file this map imports from, 2026-09-01
 * -- so this map does not duplicate that check; a "Run Now" on a disabled
 * scraper safely no-ops and records status 'blocked'.
 */
import { withJobTracking } from './db.js';
import {
  runJob1ClosingPrices,
  runJob2IntradaySync,
  runJob3DailyFundamentalsDelta,
  runBlockMarketSync,
  runWeeklyMacroSync,
} from './cron_scheduler.js';
import { fillPriceGap, fillIndexGap, fillFundamentalsGap } from './scrapers/scrape_current_gap_filler_operations.js';
import { scrapeFundamentalsForAll, scrapeLankaBDDividendArchive } from './scrapers/scrape_historical_financial_statements.js';
import { scrapeCompanyList } from './scrapers/sources/dse_company_roster.js';
import { syncHistoricalDSEXGraph, syncHistoricalDS30Graph } from './scrapers/scrape_historical_indexes.js';
import { fillFromLankaBD } from './scrapers/scrape_historical_lankabd_prices.js';
import { scrapePdfFinancialStatements } from './scrapers/scrape_pdf_financial_statements.js';
import { runAuditedEPSWeeklyScraper } from './scrapers/sources/dse_fundamentals_scraper.js';
import { scrapeDS30Membership } from './scrapers/sources/ds30_index_scraper.js';
import { runBlockMarketCrossCheck } from './auditors/audit_block_market.js';
import { runCreditRatingsCrossCheck } from './auditors/audit_credit_ratings.js';
import { runShareLockinsCrossCheck } from './auditors/audit_share_lockins.js';
import { runPdfStatementsCrossCheck } from './auditors/audit_pdf_financial_statements.js';
import { runExternalCrossCheck } from './auditors/audit_historical_prices_lankabd.js';
import { runDSEPriceCrossCheck } from './auditors/audit_historical_prices_dse.js';
import { runDSEFundamentalsCrossCheck } from './auditors/audit_historical_fundamentals_dse.js';
import { runDSEIndexCrossCheck } from './auditors/audit_historical_dsex_index.js';
import { runDSECompanyListCrossCheck } from './auditors/audit_company_roster_dse.js';

export const JOB_TRIGGER_MAP = {
  // Cron-driven -- reuse cron_scheduler.js's own tracked exports directly.
  'server.closing_prices': () => runJob1ClosingPrices(),
  'server.live_ticker': () => runJob2IntradaySync(),
  'server.fundamentals_delta': () => runJob3DailyFundamentalsDelta(),
  'historical.block_market_scraper': () => runBlockMarketSync(),
  'server.macro_indicators': () => runWeeklyMacroSync(),

  // Manual/on-demand scrapers.
  'historical.gap_scraper_price': () => withJobTracking('historical.gap_scraper_price', () => fillPriceGap()),
  'historical.gap_scraper_index': () => withJobTracking('historical.gap_scraper_index', () => fillIndexGap()),
  'historical.gap_scraper_fundamentals': () => withJobTracking('historical.gap_scraper_fundamentals', () => fillFundamentalsGap()),
  'historical.fundamentals_scraper': () => withJobTracking('historical.fundamentals_scraper', () => scrapeFundamentalsForAll()),
  'historical.lankabd_dividend_archive': () => withJobTracking('historical.lankabd_dividend_archive', () => scrapeLankaBDDividendArchive()),
  'historical.company_list_scraper': () => withJobTracking('historical.company_list_scraper', () => scrapeCompanyList()),
  'historical.dse_index_graph': () => withJobTracking('historical.dse_index_graph', () => syncHistoricalDSEXGraph()),
  'historical.lankabd_scraper': () => withJobTracking('historical.lankabd_scraper', () => fillFromLankaBD({})),
  'historical.pdf_financial_scraper': () => withJobTracking('historical.pdf_financial_scraper', () => scrapePdfFinancialStatements()),
  'server.fundamentals_weekly': () => withJobTracking('server.fundamentals_weekly', () => runAuditedEPSWeeklyScraper()),
  'server.ds30_membership': () => withJobTracking('server.ds30_membership', () => scrapeDS30Membership()),
  // Historical DS30 index graph backfill -- the only independently-gated,
  // persisting action behind this key; the *daily* DS30 level (the other
  // thing this key gates) only ever runs embedded inside Job 1, which has
  // its own "Run Now" above.
  'server.ds30_index': () => withJobTracking('server.ds30_index', () => syncHistoricalDS30Graph()),

  // Read-only cross-check auditors -- all write only to audit_reports, never
  // to the tables they check.
  'auditor.external_crosscheck_block_market': () => withJobTracking('auditor.external_crosscheck_block_market', () => runBlockMarketCrossCheck()),
  'auditor.external_crosscheck_credit_ratings': () => withJobTracking('auditor.external_crosscheck_credit_ratings', () => runCreditRatingsCrossCheck()),
  'auditor.external_crosscheck_share_lockins': () => withJobTracking('auditor.external_crosscheck_share_lockins', () => runShareLockinsCrossCheck()),
  'auditor.external_crosscheck_pdf_statements': () => withJobTracking('auditor.external_crosscheck_pdf_statements', () => runPdfStatementsCrossCheck()),
  'auditor.external_crosscheck_lankabd': () => withJobTracking('auditor.external_crosscheck_lankabd', () => runExternalCrossCheck()),
  'auditor.external_crosscheck_dse_prices': () => withJobTracking('auditor.external_crosscheck_dse_prices', () => runDSEPriceCrossCheck()),
  'auditor.external_crosscheck_dse_fundamentals': () => withJobTracking('auditor.external_crosscheck_dse_fundamentals', () => runDSEFundamentalsCrossCheck()),
  'auditor.external_crosscheck_dse_index': () => withJobTracking('auditor.external_crosscheck_dse_index', () => runDSEIndexCrossCheck()),
  'auditor.external_crosscheck_dse_companylist': () => withJobTracking('auditor.external_crosscheck_dse_companylist', () => runDSECompanyListCrossCheck()),
};
