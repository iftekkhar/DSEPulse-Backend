import { dbAll, dbRun, initStagingDB } from '../db/staging_db.js';
import { DataAuditor } from '../../../shared/data_auditor.js';

/**
 * Executes Comprehensive Institutional Audit over all tables in the Pipeline Staging Database
 */
export async function runFullStagingAudit() {
  await initStagingDB();
  const runTimestamp = new Date().toISOString();

  console.log('\n======================================================');
  console.log('   PIPELINE STAGING DATABASE INSTITUTIONAL AUDIT');
  console.log(`   Execution Time: ${runTimestamp}`);
  console.log('======================================================\n');

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalAuditedRecords = 0;

  // 1. Audit Price History in Staging DB
  console.log('1. Auditing `stg_price_history` (streaming symbol-by-symbol)...');
  const priceSymbols = await dbAll('SELECT DISTINCT symbol FROM stg_price_history ORDER BY symbol ASC');
  let priceAuditPassed = true;
  let totalPriceRecords = 0;

  for (let i = 0; i < priceSymbols.length; i++) {
    const sym = priceSymbols[i].symbol;
    const records = await dbAll('SELECT * FROM stg_price_history WHERE symbol = ? ORDER BY trade_date ASC', [sym]);
    totalPriceRecords += records.length;
    totalAuditedRecords += records.length;

    const auditRes = DataAuditor.auditPriceHistory(sym, records);
    if (!auditRes.passed) {
      priceAuditPassed = false;
      totalErrors += auditRes.errors.length;
      console.error(`  \x1b[31m✖ ERROR\x1b[0m [${sym}] Price Audit Failed:`, auditRes.errors);
    }
    totalWarnings += auditRes.warnings.length;
  }

  if (priceAuditPassed) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${totalPriceRecords.toLocaleString()} price records across ${priceSymbols.length} symbols. 0 blocking errors.`);
  }

  // 2. Audit Annual Financial Statements in Staging DB
  console.log('\n2. Auditing `stg_annual_fundamentals`...');
  const fundRows = await dbAll('SELECT * FROM stg_annual_fundamentals ORDER BY symbol, fiscal_year DESC');
  totalAuditedRecords += fundRows.length;

  const fundSymbolsMap = new Map();
  for (const r of fundRows) {
    if (!fundSymbolsMap.has(r.symbol)) fundSymbolsMap.set(r.symbol, []);
    fundSymbolsMap.get(r.symbol).push(r);
  }

  let fundAuditPassed = true;
  for (const [sym, stmts] of fundSymbolsMap.entries()) {
    const auditRes = DataAuditor.auditFinancialStatements(sym, stmts);
    if (!auditRes.passed) {
      fundAuditPassed = false;
      totalErrors += auditRes.errors.length;
      console.error(`  \x1b[31m✖ ERROR\x1b[0m [${sym}] Statements Audit Failed:`, auditRes.errors);
    }
    totalWarnings += auditRes.warnings.length;
  }
  if (fundAuditPassed) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${fundRows.length} annual disclosures across ${fundSymbolsMap.size} companies. 0 blocking errors.`);
  }

  // 2b. Audit Shareholding Pattern in Staging DB (2026-08-24) -- current
  // snapshot only, one row per symbol, same reasoning as stg_annual_fundamentals
  // above but auditShareholdingRecord checks a single current snapshot, not
  // a per-symbol array of years.
  console.log('\n2b. Auditing `stg_shareholding_current`...');
  const shRows = await dbAll('SELECT * FROM stg_shareholding_current');
  totalAuditedRecords += shRows.length;

  let shAuditPassed = true;
  for (const r of shRows) {
    const auditRes = DataAuditor.auditShareholdingRecord(r.symbol, {
      sponsorPct: r.sponsor_pct, govtPct: r.govt_pct, institutePct: r.institute_pct,
      foreignPct: r.foreign_pct, publicPct: r.public_pct,
    });
    if (!auditRes.passed) {
      shAuditPassed = false;
      totalErrors += auditRes.errors.length;
      console.error(`  \x1b[31m✖ ERROR\x1b[0m [${r.symbol}] Shareholding Audit Failed:`, auditRes.errors);
    }
    totalWarnings += auditRes.warnings.length;
  }
  if (shAuditPassed) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${shRows.length} shareholding snapshots. 0 blocking errors.`);
  }

  // 3. Audit Index History Benchmark in Staging DB
  console.log('\n3. Auditing `stg_index_history`...');
  const dsexRows = await dbAll('SELECT * FROM stg_index_history ORDER BY trade_date ASC');
  totalAuditedRecords += dsexRows.length;

  let dsexAuditPassed = true;
  if (dsexRows.length > 0) {
    const dsexAudit = DataAuditor.auditDSEXHistory(dsexRows);
    if (!dsexAudit.passed) {
      dsexAuditPassed = false;
      totalErrors += dsexAudit.errors.length;
      console.error('  \x1b[31m✖ ERROR\x1b[0m DSEX Macro Audit Failed:', dsexAudit.errors);
    }
    totalWarnings += dsexAudit.warnings.length;
    if (dsexAuditPassed) {
      console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${dsexRows.length.toLocaleString()} DSEX historical sessions. 0 blocking errors.`);
    }
  } else {
    console.log('  \x1b[33m⚠ NOTICE\x1b[0m No DSEX records currently in staging DB.');
  }

  const overallPassed = priceAuditPassed && fundAuditPassed && shAuditPassed && dsexAuditPassed && totalErrors === 0;
  const status = overallPassed ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  // Save audit report to staging database
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    runTimestamp,
    'FULL_STAGING_DB',
    totalAuditedRecords,
    totalErrors,
    totalWarnings,
    status,
    JSON.stringify({ priceAuditPassed, fundAuditPassed, shAuditPassed, dsexAuditPassed, totalErrors, totalWarnings })
  ]);

  console.log('\n======================================================');
  console.log(`AUDIT SUMMARY: ${status}`);
  console.log(`Total Records Audited : ${totalAuditedRecords}`);
  console.log(`Blocking Errors       : ${totalErrors}`);
  console.log(`Warnings / Notes      : ${totalWarnings}`);
  console.log('======================================================\n');

  return {
    passed: overallPassed,
    status,
    totalAuditedRecords,
    totalErrors,
    totalWarnings
  };
}
