import { dbAll } from '../db/staging_db.js';
import { runFullStagingAudit } from '../audit/audit_runner.js';
import {
  publishStockHistory,
  publishCompanyFundamentals,
  publishDSEXHistory
} from '../sync/publisher.js';

/**
 * MANUAL USER-CONTROLLED PROMOTION ENGINE
 * 
 * Strict Rule: This script will NEVER execute automatically.
 * It requires explicit user invocation with the `--confirm` flag.
 */
export async function promoteStagingToMainDB(explicitConfirm = false) {
  console.log('\n======================================================');
  console.log('   MANUAL PROMOTION TO MAIN BACKEND DATABASE');
  console.log('======================================================\n');

  if (!explicitConfirm) {
    console.error('  \x1b[31m✖ PROMOTION BLOCKED\x1b[0m: Explicit user confirmation required.');
    console.log('  To promote verified staging records to the Main Database, run:');
    console.log('    \x1b[33mnpm run promote:main --confirm\x1b[0m\n');
    return { success: false, reason: 'Confirmation flag missing' };
  }

  // 1. Mandatory Audit Gate Check
  console.log('Step 1: Running mandatory institutional audit gate...');
  const auditResult = await runFullStagingAudit();

  if (!auditResult.passed || auditResult.totalErrors > 0) {
    console.error('  \x1b[31m✖ PROMOTION HALTED\x1b[0m: Staging data has audit errors.');
    console.error(`  Total Blocking Errors: ${auditResult.totalErrors}`);
    console.error('  Resolve audit errors before promoting to Main DB.\n');
    return { success: false, reason: 'Audit failed', errors: auditResult.totalErrors };
  }

  console.log('  \x1b[32m✔ AUDIT GATE PASSED\x1b[0m (0 blocking errors). Proceeding with user-authorized promotion...\n');

  // 2. Promote Staged Index (DSEX) Records
  // NOTE: field names below map stg_index_history's real columns onto the exact
  // payload shape /api/ingest/dsex expects (see server/index.js) — the ingest
  // endpoint silently no-ops on any record missing `date`/`dsexIndex`.
  const dsexRows = await dbAll('SELECT * FROM stg_index_history ORDER BY trade_date ASC');
  if (dsexRows.length > 0) {
    // `?? null`, not `|| 0`: stg_index_history genuinely has no breadth data for
    // any source (KAGGLE/DSE_OFFICIAL_*/MCAP_WEIGHTED_ESTIMATE only ever populate
    // index_value) -- `|| 0` was turning every one of those real nulls into a
    // fabricated "confirmed zero advancers" written permanently into main DB's
    // 20-year DSEX history.
    const mappedDsex = dsexRows.map(r => ({
      date: r.trade_date,
      dsexIndex: r.index_value,
      advancing: r.advancing ?? null,
      declining: r.declining ?? null,
      unchanged: r.unchanged ?? null,
      turnoverMn: r.total_value_mn ?? null,
      volume: r.total_volume ?? null
    }));
    console.log(`Promoting ${mappedDsex.length} DSEX historical sessions to Main DB...`);
    await publishDSEXHistory(mappedDsex);
    console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted ${mappedDsex.length} DSEX sessions.`);
  }

  // 3. Promote Staged Price History
  // Mapped onto /api/ingest/history's expected shape: {date, close, ycp, change, changePercent, volume, pe}
  // `?? null` throughout, not `|| 0`: this was previously coercing every genuinely
  // unknown volume/change/changePercent into a fabricated "confirmed zero" before
  // it ever reached saveSymbolHistoryBulk's own (correct) null-preserving logic --
  // silently re-introducing the fabricated-zero-volume bug on every future
  // promotion run, even after the existing rows were patched once by hand.
  const priceRows = await dbAll('SELECT * FROM stg_price_history ORDER BY symbol, trade_date ASC');
  const priceSymbolsMap = new Map();
  for (const r of priceRows) {
    const mapped = {
      date: r.trade_date,
      close: r.close,
      // `?? null`, not `?? r.close`: defaulting yesterday's close to today's close
      // when genuinely unknown silently fabricates "0% change" downstream (close -
      // ycp = 0), for every one of the 130K+ rows where ycp was never scraped.
      ycp: r.ycp ?? null,
      change: r.change_amt ?? null,
      changePercent: r.change_pct ?? null,
      volume: r.volume ?? null,
      pe: null
    };
    if (!priceSymbolsMap.has(r.symbol)) priceSymbolsMap.set(r.symbol, []);
    priceSymbolsMap.get(r.symbol).push(mapped);
  }

  for (const [sym, records] of priceSymbolsMap.entries()) {
    console.log(`Promoting ${records.length} price records for ${sym}...`);
    await publishStockHistory(sym, records);
  }
  console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted price histories across ${priceSymbolsMap.size} symbols.`);

  // 4. Promote Staged Annual Financial Statements
  // Mapped onto /api/ingest/fundamentals's expected `statements[]` shape
  const fundRows = await dbAll('SELECT * FROM stg_annual_fundamentals ORDER BY symbol, fiscal_year DESC');
  const fundSymbolsMap = new Map();
  for (const r of fundRows) {
    const mapped = {
      year: r.fiscal_year,
      eps: r.eps,
      navps: r.navps,
      roe: r.roe,
      dividendYield: r.dividend_yield,
      pe: r.pe_ratio,
      paidUpCapital: r.paid_up_capital_mn,
      auditStatus: 'Audited'
    };
    if (!fundSymbolsMap.has(r.symbol)) fundSymbolsMap.set(r.symbol, []);
    fundSymbolsMap.get(r.symbol).push(mapped);
  }

  for (const [sym, stmts] of fundSymbolsMap.entries()) {
    console.log(`Promoting ${stmts.length} audited statements for ${sym}...`);
    // stmts[0] is the latest fiscal year (ordered DESC) — use it to also
    // refresh the symbol's "current" fundamentals snapshot, not just history.
    // auditedPeriod MUST be included here: server/db.js's saveFundamentals only
    // replaces period-coupled fields (like navPerShare) atomically when it can see
    // the incoming audited_period differs from what's stored -- without it, a
    // genuinely-null field (e.g. this year's NAVPS not yet disclosed by DSE) falls
    // back to preserving whatever the OLD fiscal year's value was, silently tagging
    // a prior year's number as if it belonged to the current one.
    const latest = stmts[0] || {};
    const fundamentalsSnapshot = {
      eps: latest.eps ?? null,
      navPerShare: latest.navps ?? null,
      peBasic: latest.pe ?? null,
      dividendYield: latest.dividendYield ?? null,
      paidUpCapital: latest.paidUpCapital ?? null,
      auditedPeriod: latest.year ? `FY${latest.year} Audited` : null
    };
    await publishCompanyFundamentals(sym, fundamentalsSnapshot, stmts);
  }
  console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted audited statements across ${fundSymbolsMap.size} companies.`);

  console.log('\n======================================================');
  console.log('   PROMOTION COMPLETED SUCCESSFULLY');
  console.log('   Main Database is now synchronized with audited data.');
  console.log('======================================================\n');

  return { success: true, priceSymbols: priceSymbolsMap.size, fundSymbols: fundSymbolsMap.size };
}
