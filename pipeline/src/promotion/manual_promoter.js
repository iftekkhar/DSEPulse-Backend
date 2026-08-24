import { dbAll } from '../db/staging_db.js';
import { runFullStagingAudit } from '../audit/audit_runner.js';
import {
  publishStockHistory,
  publishCompanyFundamentals,
  publishDSEXHistory,
  publishCompanyList,
  publishShareholding
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
      volume: r.total_volume ?? null,
      // Uniformly STAGING_DB now, not the granular staging-internal tier --
      // see the price_history mapping above and shared/source_tiers.js.
      source: 'STAGING_DB'
    }));
    console.log(`Promoting ${mappedDsex.length} DSEX historical sessions to Main DB...`);
    await publishDSEXHistory(mappedDsex);
    console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted ${mappedDsex.length} DSEX sessions.`);
  }

  // 3. Promote Staged Price History
  // Mapped onto /api/ingest/history's expected shape. `?? null` throughout,
  // not `|| 0`: this was previously coercing every genuinely unknown
  // volume/change/changePercent into a fabricated "confirmed zero" before it
  // ever reached saveSymbolHistoryBulk's own (correct) null-preserving logic.
  // Now includes open/high/low/valueMn too (2026-08-23) -- these existed in
  // stg_price_history all along but were never mapped through, so main DB's
  // price_history had never stored real OHLC/turnover data at all, only
  // close. Every field here is passed through exactly as staging has it --
  // per policy, this table must match staging 100%, cell for cell.
  const priceRows = await dbAll('SELECT * FROM stg_price_history ORDER BY symbol, trade_date ASC');
  const priceSymbolsMap = new Map();
  for (const r of priceRows) {
    const mapped = {
      date: r.trade_date,
      open: r.open ?? null,
      high: r.high ?? null,
      low: r.low ?? null,
      close: r.close,
      // `?? null`, not `?? r.close`: defaulting yesterday's close to today's close
      // when genuinely unknown silently fabricates "0% change" downstream (close -
      // ycp = 0), for every one of the 130K+ rows where ycp was never scraped.
      ycp: r.ycp ?? null,
      change: r.change_amt ?? null,
      changePercent: r.change_pct ?? null,
      volume: r.volume ?? null,
      valueMn: r.value_mn ?? null,
      pe: null,
      // Every promotion run tags STAGING_DB uniformly now (staging itself is
      // Tier 1 for main DB's purposes) rather than forwarding the granular
      // staging-internal tier (DSE_SCRAPE/LANKABD/etc.) -- see
      // shared/source_tiers.js. That granular tier still matters and is still
      // tracked, just inside stg_price_history, not in main DB.
      source: 'STAGING_DB'
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
      dps: r.dps,
      pe: r.pe_ratio,
      paidUpCapital: r.paid_up_capital_mn,
      auditStatus: 'Audited'
    };
    if (!fundSymbolsMap.has(r.symbol)) fundSymbolsMap.set(r.symbol, []);
    fundSymbolsMap.get(r.symbol).push(mapped);
  }

  for (const [sym, stmts] of fundSymbolsMap.entries()) {
    console.log(`Promoting ${stmts.length} audited statements for ${sym}...`);
    // "Current" is no longer a separate write -- server/db.js derives it from
    // each symbol's latest fiscal_year row in fundamentals_history directly
    // (company_fundamentals dropped 2026-08-23, see ARCHITECTURE.md), so
    // there's nothing left to compute/send here beyond the statements
    // themselves.
    await publishCompanyFundamentals(sym, stmts);
  }
  console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted audited statements across ${fundSymbolsMap.size} companies.`);

  // 5. Promote the full company/instrument roster (added 2026-08-23)
  const companyRows = await dbAll('SELECT * FROM stg_company_list ORDER BY symbol ASC');
  if (companyRows.length > 0) {
    const mappedCompanies = companyRows.map(r => ({
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      category: r.category,
      listing_date: r.listing_date,
      face_value: r.face_value,
      total_shares: r.total_shares,
      market_cap_mn: r.market_cap_mn,
      is_active: r.is_active,
      fetched_at: r.fetched_at
    }));
    console.log(`Promoting ${mappedCompanies.length} company list entries...`);
    const result = await publishCompanyList(mappedCompanies);
    console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted company_list: ${result.upserted} upserted, ${result.pruned} pruned.`);
  }

  // 6. Promote shareholding snapshots (current + prior-disclosed-month only,
  // added 2026-08-24 -- see stg_shareholding_current's own comment). Reshaped
  // into the { symbol, shareholding: { current, previous } } payload
  // /api/ingest/shareholding (and saveShareholdingCurrent underneath it)
  // already expects -- the exact same shape server/'s own live scraper path
  // produces, so both promotion routes into this table share one write path.
  const shRows = await dbAll('SELECT * FROM stg_shareholding_current');
  if (shRows.length > 0) {
    const mappedShareholding = shRows.map(r => ({
      symbol: r.symbol,
      shareholding: {
        current: {
          asOfDate: r.as_of_date, sponsorPct: r.sponsor_pct, govtPct: r.govt_pct,
          institutePct: r.institute_pct, foreignPct: r.foreign_pct, publicPct: r.public_pct,
        },
        previous: r.prev_as_of_date ? {
          asOfDate: r.prev_as_of_date, sponsorPct: r.prev_sponsor_pct, govtPct: r.prev_govt_pct,
          institutePct: r.prev_institute_pct, foreignPct: r.prev_foreign_pct, publicPct: r.prev_public_pct,
        } : null,
      },
    }));
    console.log(`Promoting ${mappedShareholding.length} shareholding snapshots...`);
    const shResult = await publishShareholding(mappedShareholding);
    console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted shareholding: ${shResult.saved} saved.`);
  }

  console.log('\n======================================================');
  console.log('   PROMOTION COMPLETED SUCCESSFULLY');
  console.log('   Main Database is now synchronized with audited data.');
  console.log('======================================================\n');

  return { success: true, priceSymbols: priceSymbolsMap.size, fundSymbols: fundSymbolsMap.size, companyRows: companyRows.length };
}
