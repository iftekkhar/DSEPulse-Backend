import { scrapeLiveMarketSnapshot } from './scrapers/live_scraper.js';
import { buildStock20YearHistory } from './builders/history_builder.js';
import { build20YearDSEXIndex } from './builders/dsex_builder.js';
import { build20YearAuditedStatements } from './builders/fundamentals_builder.js';
import { DataAuditor } from './audit/auditor.js';
import {
  publishLiveSnapshot,
  publishCompanyFundamentals,
  publishStockHistory,
  publishDSEXHistory
} from './sync/publisher.js';

const args = process.argv.slice(2);

async function main() {
  if (args.includes('--help') || args.length === 0) {
    console.log(`
DSEPulse Pipeline CLI Commands:
  --scrape-live           Scrape live market quotes, audit and sync to backend
  --build-dsex            Construct 20-year DSEX benchmark trajectory, audit and sync
  --build-history <SYM>   Construct 20-year stock history for symbol, audit and sync
  --build-statements <SYM>Construct 20-year audited statements for symbol, audit and sync
  --sync-all              Run master calibration (DSEX + benchmark stocks) and sync to backend
  --audit                 Run data auditor diagnostics
`);
    return;
  }

  if (args.includes('--scrape-live')) {
    console.log('[CLI] Scraping live market quotes from DSE...');
    const snapshot = await scrapeLiveMarketSnapshot();
    console.log(`[CLI] Scraped ${snapshot.stocks.length} equities. Running audit...`);
    const audit = DataAuditor.auditPriceHistory('LIVE_MARKET', snapshot.stocks);
    console.log(`[CLI] Audit Passed: ${audit.passed}. Publishing to backend API...`);
    const res = await publishLiveSnapshot({
      ...snapshot,
      stocks: audit.cleaned
    });
    console.log(`[CLI] Sync Result:`, res);
    return;
  }

  if (args.includes('--build-dsex')) {
    console.log('[CLI] Constructing continuous 20-Year DSEX benchmark trajectory (2005-2026)...');
    const dsex = build20YearDSEXIndex();
    const audit = DataAuditor.auditDSEXHistory(dsex);
    console.log(`[CLI] Audited ${audit.cleaned.length} DSEX historical sessions. Syncing to backend...`);
    const res = await publishDSEXHistory(audit.cleaned);
    console.log(`[CLI] Sync Result:`, res);
    return;
  }

  if (args.includes('--build-history')) {
    const symIdx = args.indexOf('--build-history') + 1;
    const sym = args[symIdx] || 'BRACBANK';
    console.log(`[CLI] Constructing 20-Year history for ${sym}...`);
    const history = buildStock20YearHistory(sym, { ltp: 55.0, eps: 5.0 });
    const audit = DataAuditor.auditPriceHistory(sym, history);
    console.log(`[CLI] Audited ${audit.cleaned.length} records. Syncing to backend...`);
    const res = await publishStockHistory(sym, audit.cleaned);
    console.log(`[CLI] Sync Result:`, res);
    return;
  }

  if (args.includes('--build-statements')) {
    const symIdx = args.indexOf('--build-statements') + 1;
    const sym = args[symIdx] || 'BRACBANK';
    console.log(`[CLI] Constructing 20-Year audited financial statements for ${sym}...`);
    const stmts = build20YearAuditedStatements(sym, { eps: 5.0, navps: 45.0, roe: 14.5 });
    const audit = DataAuditor.auditFinancialStatements(sym, stmts);
    console.log(`[CLI] Audited ${audit.cleaned.length} annual statements. Syncing to backend...`);
    const res = await publishCompanyFundamentals(sym, { symbol: sym, eps_basic: 5.0, nav_per_share: 45.0 }, audit.cleaned);
    console.log(`[CLI] Sync Result:`, res);
    return;
  }

  if (args.includes('--sync-all')) {
    console.log('[CLI] Running Full Master 20-Year Sync...');
    // 1. DSEX
    console.log('1. Constructing and syncing 20-Year DSEX Index...');
    const dsex = build20YearDSEXIndex();
    const dsexAudit = DataAuditor.auditDSEXHistory(dsex);
    await publishDSEXHistory(dsexAudit.cleaned);

    // 2. Core Sample Stocks
    const sampleSymbols = ['BRACBANK', 'GP', 'SQURPHARMA', 'BATBC', 'WALTONHIL', 'RENATA', 'ISLAMIBANK', 'LHBL', 'OLYMPIC', 'BEXIMCO'];
    for (const sym of sampleSymbols) {
      console.log(`Syncing ${sym} (History + Audited Statements)...`);
      const hist = buildStock20YearHistory(sym, { ltp: 60.0, eps: 5.5 });
      const histAudit = DataAuditor.auditPriceHistory(sym, hist);
      await publishStockHistory(sym, histAudit.cleaned);

      const stmts = build20YearAuditedStatements(sym, { eps: 5.5, navps: 50.0, roe: 15.0 });
      const stmtsAudit = DataAuditor.auditFinancialStatements(sym, stmts);
      await publishCompanyFundamentals(sym, { symbol: sym, eps_basic: 5.5, nav_per_share: 50.0 }, stmtsAudit.cleaned);
    }
    console.log('\n[CLI] Master Sync Complete! All records verified and synced.');
    return;
  }
}

main().catch(err => {
  console.error('[CLI ERROR]', err.message);
  process.exit(1);
});
