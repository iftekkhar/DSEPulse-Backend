/**
 * Live cross-check audit for stg_annual_fundamentals: re-fetches every company's
 * current dsebd.org page (the same live source fundamentals_scraper.js reads)
 * and diffs it field-by-field against what's already staged.
 *
 * This exists because the standing DataAuditor is range-based (EPS within
 * -200..1000, NAVPS, P/E within 0..300 as a warning, etc.) -- a real, permanent
 * check, but a plausible-looking wrong number that falls inside those bounds
 * sails through it undetected. A 57-symbol batch of fabricated FY2025
 * fundamentals from a since-fixed scraper bug did exactly that: 2 of the 57
 * happened to exceed the EPS range and got flagged, the other 55 with smaller
 * (but equally wrong) values did not. This is the fix for that blind spot --
 * live cross-checking is the PRIMARY correctness check for this table; the
 * range-based audit stays in place as a fast, always-on secondary pass, not
 * the main gate.
 *
 * LankaBangla does not publish company fundamentals (it's a price-history
 * source only), so DSE is the sole real source to check this table against --
 * unlike price_history, which has both DSE and LankaBD to cross-check.
 */
import { initStagingDB, dbAll, dbRun } from '../db/staging_db.js';
import { scrapeCompanyFundamentals } from '../scrapers/fundamentals_scraper.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fields worth diffing -- the numeric disclosure fields a wrong parse could
// corrupt. total_shares/paid_up_capital_mn/market_cap_mn are deliberately
// excluded: those come from stg_company_list's current snapshot, not from
// this page's per-year tables, so they're out of scope for this specific check.
const FIELDS = ['eps', 'navps', 'dps', 'bonus_pct', 'pe_ratio', 'dividend_yield'];

function fieldsDiffer(a, b, tolerance = 0.011) {
  const av = a === undefined ? null : a;
  const bv = b === undefined ? null : b;
  if (av === null && bv === null) return false;
  if (av === null || bv === null) return true;
  return Math.abs(Number(av) - Number(bv)) > tolerance;
}

/**
 * Cross-checks every fiscal year currently staged for `symbols` against a
 * fresh live scrape of the same DSE page. Read-only against fundamentals data
 * -- only writes an audit_reports row and a CSV of the mismatches found, same
 * pattern as external_crosscheck_lankabd.js.
 */
export async function runDSEFundamentalsCrossCheck({ symbols = null } = {}) {
  if (!isScraperEnabled('pipeline.external_crosscheck_dse_fundamentals')) {
    console.log(scraperBlockedMessage('pipeline.external_crosscheck_dse_fundamentals'));
    return { blocked: true };
  }
  await initStagingDB();

  const targetSymbols = symbols || (await dbAll('SELECT DISTINCT symbol FROM stg_annual_fundamentals ORDER BY symbol')).map(r => r.symbol);

  console.log(`\n[DSE Fundamentals Cross-Check] Re-scraping ${targetSymbols.length} companies live from dsebd.org...`);

  const mismatches = [];
  let yearsCompared = 0;
  let missingInDb = 0;
  let missingLive = 0;
  let symbolsChecked = 0;
  let symbolsErrored = 0;

  for (let i = 0; i < targetSymbols.length; i++) {
    const symbol = targetSymbols[i];
    let live;
    try {
      live = await scrapeCompanyFundamentals(symbol);
    } catch (e) {
      console.error(`[${i + 1}/${targetSymbols.length}] ${symbol}: ERROR fetching live -- ${e.message}`);
      symbolsErrored++;
      await sleep(1000);
      continue;
    }
    symbolsChecked++;

    const dbRows = await dbAll('SELECT * FROM stg_annual_fundamentals WHERE symbol = ?', [symbol]);
    const dbByYear = new Map(dbRows.map(r => [r.fiscal_year, r]));
    const liveByYear = new Map(live.map(r => [r.fiscal_year, r]));

    for (const [year, liveRow] of liveByYear.entries()) {
      const dbRow = dbByYear.get(year);
      if (!dbRow) { missingInDb++; continue; }
      yearsCompared++;
      for (const f of FIELDS) {
        if (fieldsDiffer(dbRow[f], liveRow[f])) {
          mismatches.push({ symbol, fiscal_year: year, field: f, db_value: dbRow[f], live_value: liveRow[f] });
        }
      }
    }
    for (const year of dbByYear.keys()) {
      if (!liveByYear.has(year)) missingLive++;
    }

    if ((i + 1) % 25 === 0) {
      console.log(`  [${i + 1}/${targetSymbols.length}] processed, ${mismatches.length} field mismatches so far...`);
    }
    await sleep(600);
  }

  const summary = {
    symbolsChecked,
    symbolsErrored,
    yearsCompared,
    totalMismatches: mismatches.length,
    missingInDb,       // live DSE has a year our staging table doesn't -- a real gap
    missingLive,       // staging has a year DSE's live page no longer shows -- exactly today's bug pattern
  };

  console.log('\n======================================================');
  console.log('   DSE FUNDAMENTALS LIVE CROSS-CHECK SUMMARY');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));

  const csvPath = path.join(__dirname, '..', '..', 'data', 'dse_fundamentals_crosscheck_mismatches.csv');
  const lines = ['symbol,fiscal_year,field,db_value,live_value'];
  for (const m of mismatches) lines.push(`${m.symbol},${m.fiscal_year},${m.field},${m.db_value},${m.live_value}`);
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nFull mismatch list written to: ${csvPath}`);

  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_DSE_FUNDAMENTALS',
    yearsCompared,
    mismatches.length,
    missingInDb + missingLive,
    mismatches.length === 0 ? 'EXTERNAL_VERIFIED_CLEAN' : 'EXTERNAL_MISMATCHES_FOUND',
    JSON.stringify(summary),
  ]);

  return { summary, mismatches };
}
