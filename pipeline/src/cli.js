/**
 * DSEPulse Pipeline Engine — CLI
 *
 * RULE: This pipeline NEVER updates the Main DB automatically.
 *       Promotion to Main DB requires passing audits AND explicit --confirm.
 */

import { initStagingDB, dbAll, dbGet } from './db/staging_db.js';
import { scrapeCompanyList }      from './scrapers/company_list_scraper.js';
import { importMendeleyPrices, importIndexHistory } from './importers/mendeley_importer.js';
import { scrapeFundamentalsForAll } from './scrapers/fundamentals_scraper.js';
import { fillPriceGap, fillIndexGap } from './scrapers/gap_scraper.js';
import { runFullAnalyticsPipeline, computeFundamentalDerivedRatios, getSymbolAnalytics } from './builders/analytics_engine.js';
import { runFullStagingAudit }     from './audit/audit_runner.js';
import { promoteStagingToMainDB }  from './promotion/manual_promoter.js';

const args = process.argv.slice(2);

// ─────────────────────────────────────────────────────────────────────────────
//  HELP TEXT
// ─────────────────────────────────────────────────────────────────────────────
const HELP = `
╔══════════════════════════════════════════════════════════════════════╗
║     DSEPULSE PIPELINE ENGINE — STAGING & AUDIT ENVIRONMENT           ║
║     Scope: 2013-01-01 → Yesterday  (DSEX era only)                  ║
╠══════════════════════════════════════════════════════════════════════╣
║  SETUP                                                               ║
║  --init-db                   Initialize / expand staging.db schema   ║
║                                                                      ║
║  COMPANY LIST (Active symbols only)                                  ║
║  --fetch-company-list        Scrape all active DSE symbols today     ║
║  --fetch-company-list --details  Also fetch name/sector/category     ║
║                                                                      ║
║  DATA IMPORT (Mendeley dataset — seed 2013-01-01 → 2025-04-08)      ║
║  --import-prices             Import Mendeley price history CSV       ║
║  --import-index              Import Mendeley DSEX + Kaggle index CSV ║
║                                                                      ║
║  LIVE SCRAPING (gap fill + fundamentals)                             ║
║  --scrape-gap                Fill gap: 2025-04-09 → yesterday        ║
║  --scrape-fundamentals       Scrape OFFICIAL audited EPS/NAV from DSE║
║  --scrape-fundamentals --symbol BRACBANK  (single symbol)            ║
║                                                                      ║
║  ANALYTICS                                                           ║
║  --compute-all               Run fundamental derived-ratio compute   ║
║  --compute-fundamentals      Derived ratios only (PE/PB/ROE/CAGR)   ║
║  --show-analytics SYMBOL     Show on-demand technical/performance    ║
║                               analytics for one symbol (not stored,  ║
║                               computed fresh -- see analytics_engine)║
║                                                                      ║
║  BUILD EVERYTHING (full pipeline in sequence)                        ║
║  --build-full                Run all phases 0–5 in order             ║
║  --resume                    Resume pipeline from where it left off  ║
║                                                                      ║
║  AUDIT & CERTIFICATION                                               ║
║  --audit                     Run institutional audit on staging.db   ║
║  --report                    View audit certification history        ║
║                                                                      ║
║  PROMOTION (user-triggered ONLY — requires passing audit + --confirm)║
║  --promote-main --confirm    Promote certified staging to Main DB    ║
║                                                                      ║
║  SCOPE: 2013-01-01 → Yesterday. Pre-2013 (DGEN era) excluded.       ║
║  RULE: The pipeline NEVER updates the Main DB automatically.         ║
╚══════════════════════════════════════════════════════════════════════╝
`;

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {

  if (args.includes('--help') || args.length === 0) {
    console.log(HELP);
    return;
  }

  // ── Init DB ──────────────────────────────────────────────────────────────
  if (args.includes('--init-db')) {
    await initStagingDB();
    console.log('[CLI] ✅ Staging Database initialized with expanded schema.');
    return;
  }

  // ── Fetch Company List (Active Only) ──────────────────────────────────────
  if (args.includes('--fetch-company-list')) {
    const fetchDetails = args.includes('--details');
    console.log(`[CLI] Fetching active DSE company list${fetchDetails ? ' (with details)' : ''}...`);
    const res = await scrapeCompanyList({ fetchDetails });
    console.log(`[CLI] ✅ ${res.count} active symbols fetched and saved.`);
    return;
  }

  // ── Import Mendeley Prices ────────────────────────────────────────────────
  if (args.includes('--import-prices')) {
    console.log('[CLI] Importing Mendeley price history (active symbols only)...');
    const stats = await importMendeleyPrices();
    console.log(`[CLI] ✅ Mendeley price import: ${stats.imported.toLocaleString()} records.`);
    return;
  }

  // ── Import Index History (Mendeley DSEX + Kaggle) ─────────────────────────
  if (args.includes('--import-index')) {
    console.log('[CLI] Importing index history (Mendeley DSEX + Kaggle supplement)...');
    const log = await importIndexHistory();
    console.log(`[CLI] ✅ Index import complete.`);
    return;
  }

  // ── Scrape Price Gap (2025-04-09 → yesterday) ─────────────────────────────
  if (args.includes('--scrape-gap')) {
    const symIdx = args.indexOf('--symbol');
    const sym = symIdx >= 0 ? args[symIdx + 1] : null;
    console.log(`[CLI] Filling price gap for ${sym ? sym : 'all active symbols'}...`);
    const res = await fillPriceGap({ symbols: sym ? [sym.toUpperCase()] : null });
    console.log(`[CLI] ✅ Gap fill: ${res.filled} new records added.`);
    if (!sym) {
      console.log('[CLI] Filling DSEX index benchmark gap...');
      await fillIndexGap();
    }
    return;
  }

  // ── Scrape Official Fundamentals ──────────────────────────────────────────
  if (args.includes('--scrape-fundamentals')) {
    const symIdx = args.indexOf('--symbol');
    const sym = symIdx >= 0 ? args[symIdx + 1] : null;
    console.log(`[CLI] Scraping OFFICIAL audited fundamentals from dsebd.org...`);
    console.log(`[CLI] NOTE: Only officially disclosed company data is imported.`);
    const res = await scrapeFundamentalsForAll({ symbols: sym ? [sym.toUpperCase()] : null });
    console.log(`[CLI] ✅ Fundamentals: ${res.totalDisclosures} official disclosures staged.`);
    return;
  }

  // ── Compute All Analytics ─────────────────────────────────────────────────
  if (args.includes('--compute-all')) {
    await runFullAnalyticsPipeline();
    return;
  }

  if (args.includes('--show-analytics')) {
    const symIdx = args.indexOf('--show-analytics');
    const sym = args[symIdx + 1];
    if (!sym) { console.log('[CLI] Usage: --show-analytics SYMBOL'); return; }
    const result = await getSymbolAnalytics(sym.toUpperCase());
    if (!result || result.technical.length === 0) {
      console.log(`[CLI] No analytics available for ${sym.toUpperCase()} (need at least 20 price rows).`);
      return;
    }
    const latest = result.technical[result.technical.length - 1];
    console.log(`[CLI] ${result.symbol} — latest technical indicators (${latest.trade_date}):`);
    console.log(latest);
    console.log(`\n[CLI] ${result.symbol} — performance summary (as of ${result.performance.as_of_date}):`);
    console.log(result.performance);
    return;
  }

  if (args.includes('--compute-fundamentals')) {
    const n = await computeFundamentalDerivedRatios();
    console.log(`[CLI] ✅ Fundamental ratios: ${n} records updated.`);
    return;
  }

  // ── Full Pipeline Build ────────────────────────────────────────────────────
  if (args.includes('--build-full')) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║     DSEPULSE PIPELINE — FULL BUILD SEQUENCE          ║');
    console.log('║     Scope: 2013-01-01 → Yesterday (DSEX era)         ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Phase 0
    console.log('📦 Phase 0: Initializing Staging Database...');
    await initStagingDB();

    // Phase 1
    console.log('\n🏢 Phase 1: Fetching Active Company List from dsebd.org...');
    await scrapeCompanyList({ fetchDetails: false });

    // Phase 2
    console.log('\n📥 Phase 2a: Importing Mendeley Price History (active symbols only)...');
    await importMendeleyPrices();

    console.log('\n📥 Phase 2b: Importing Index History (DSEX + DGEN)...');
    await importIndexHistory();

    // Phase 3
    console.log('\n🔄 Phase 3a: Filling Price & Benchmark Gap (Mendeley cutoff → yesterday)...');
    await fillPriceGap();
    await fillIndexGap();

    console.log('\n📊 Phase 3b: Scraping Official Annual Fundamentals from dsebd.org...');
    console.log('    NOTE: Only officially disclosed/audited data is imported.');
    await scrapeFundamentalsForAll();

    // Phase 4 -- fundamental derived ratios only; technical/performance analytics
    // are computed on demand (getSymbolAnalytics), nothing to pre-compute here.
    console.log('\n🧮 Phase 4: Computing Fundamental Derived Ratios...');
    await runFullAnalyticsPipeline();

    // Phase 5
    console.log('\n🔍 Phase 5: Running Institutional Audit...');
    await runFullStagingAudit();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  ✅ FULL PIPELINE BUILD COMPLETE                     ║');
    console.log('║  Run `npm run report` to view audit certification.   ║');
    console.log('║  Run `npm run promote:main --confirm` to promote.    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    return;
  }

  // ── Resume Pipeline ───────────────────────────────────────────────────────
  if (args.includes('--resume')) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║     DSEPULSE PIPELINE — SMART RESUME ENGINE          ║');
    console.log('║     Checking staging state & resuming pending tasks  ║');
    console.log('║     Scope: 2013-01-01 → Yesterday (DSEX era)         ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    await initStagingDB();

    // Check Phase 1: Company List
    const compCount = (await dbGet('SELECT COUNT(*) AS cnt FROM stg_company_list WHERE is_active = 1'))?.cnt || 0;
    if (compCount === 0) {
      console.log('🏢 [Resume] Phase 1: Fetching Active Company List from dsebd.org...');
      await scrapeCompanyList({ fetchDetails: false });
    } else {
      console.log(`🏢 [Resume] Phase 1: SKIPPED (already has ${compCount} active companies)`);
    }

    // Check Phase 2a: Price History
    const priceCount = (await dbGet('SELECT COUNT(*) AS cnt FROM stg_price_history'))?.cnt || 0;
    if (priceCount < 500000) {
      console.log('\n📥 [Resume] Phase 2a: Importing Mendeley Price History (2013-01-01+)...');
      await importMendeleyPrices();
    } else {
      console.log(`\n📥 [Resume] Phase 2a: SKIPPED (already has ${priceCount.toLocaleString()} price records)`);
    }

    // Check Phase 2b: Index History
    const indexCount = (await dbGet('SELECT COUNT(*) AS cnt FROM stg_index_history'))?.cnt || 0;
    if (indexCount === 0) {
      console.log('\n📥 [Resume] Phase 2b: Importing Index History (DSEX)...');
      await importIndexHistory();
    } else {
      console.log(`\n📥 [Resume] Phase 2b: SKIPPED (already has ${indexCount.toLocaleString()} index records)`);
    }

    // Check Phase 3a: Gap Scraper
    console.log('\n🔄 [Resume] Phase 3a: Checking Price & Benchmark Gap (Mendeley cutoff → yesterday)...');
    await fillPriceGap({ resume: true });
    await fillIndexGap();

    // Check Phase 3b: Fundamentals Scraper
    console.log('\n📊 [Resume] Phase 3b: Scraping Official Annual Fundamentals (resuming pending)...');
    await scrapeFundamentalsForAll({ resume: true });

    // Phase 4: Fundamental derived ratios (technical/performance analytics are
    // computed on demand -- see getSymbolAnalytics -- no persisted table to check
    // a watermark against, so this always just runs; it's cheap, ~2k rows).
    console.log('\n🧮 [Resume] Phase 4: Computing Fundamental Derived Ratios...');
    await runFullAnalyticsPipeline();

    // Phase 5: Audit
    console.log('\n🔍 [Resume] Phase 5: Running Institutional Audit...');
    await runFullStagingAudit();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  ✅ RESUME PIPELINE RUN COMPLETE                     ║');
    console.log('║  Run `npm run report` to view audit certification.   ║');
    console.log('║  Run `npm run promote:main --confirm` to promote.    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    return;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  if (args.includes('--audit')) {
    await runFullStagingAudit();
    return;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (args.includes('--report')) {
    await initStagingDB();
    const reports = await dbAll('SELECT * FROM audit_reports ORDER BY id DESC LIMIT 10');
    console.log('\n======================================================');
    console.log('   RECENT AUDIT CERTIFICATION REPORTS (STAGING DB)');
    console.log('======================================================\n');
    if (reports.length === 0) {
      console.log('No audit reports found. Run `npm run audit` first.');
    } else {
      console.table(reports.map(r => ({
        ID: r.id,
        'Run Time': r.run_at,
        Entity: r.target_entity,
        Records: r.records_audited,
        Errors: r.errors_count,
        Warnings: r.warnings_count,
        Status: r.status,
      })));
    }
    return;
  }

  // ── Promote (Manual Only) ─────────────────────────────────────────────────
  if (args.includes('--promote-main')) {
    const hasConfirm = args.includes('--confirm');
    await promoteStagingToMainDB(hasConfirm);
    return;
  }

  console.log('[CLI] Unknown command. Run with --help to see all options.');
}

main().catch(err => {
  console.error('[CLI ERROR]', err.message);
  process.exit(1);
});
