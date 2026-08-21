import { dbAll, dbRun, initStagingDB } from '../db/staging_db.js';
import { DataAuditor } from './auditor.js';

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
  console.log('1. Auditing `stg_price_history`...');
  const priceRows = await dbAll('SELECT * FROM stg_price_history ORDER BY symbol, date ASC');
  totalAuditedRecords += priceRows.length;

  const symbolsMap = new Map();
  for (const r of priceRows) {
    if (!symbolsMap.has(r.symbol)) symbolsMap.set(r.symbol, []);
    symbolsMap.get(r.symbol).push(r);
  }

  let priceAuditPassed = true;
  for (const [sym, records] of symbolsMap.entries()) {
    const auditRes = DataAuditor.auditPriceHistory(sym, records);
    if (!auditRes.passed) {
      priceAuditPassed = false;
      totalErrors += auditRes.errors.length;
      console.error(`  \x1b[31m✖ ERROR\x1b[0m [${sym}] Price Audit Failed:`, auditRes.errors);
    }
    totalWarnings += auditRes.warnings.length;
  }
  if (priceAuditPassed) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${priceRows.length} price records across ${symbolsMap.size} symbols. 0 blocking errors.`);
  }

  // 2. Audit 20-Year Financial Statements in Staging DB
  console.log('\n2. Auditing `stg_fundamentals_history`...');
  const fundRows = await dbAll('SELECT * FROM stg_fundamentals_history ORDER BY symbol, fiscal_year DESC');
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

  // 3. Audit DSEX Macro Benchmark in Staging DB
  console.log('\n3. Auditing `stg_dsex_market_history`...');
  const dsexRows = await dbAll('SELECT * FROM stg_dsex_market_history ORDER BY date ASC');
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
      console.log(`  \x1b[32m✔ PASS\x1b[0m Audited ${dsexRows.length} DSEX historical sessions. 0 blocking errors.`);
    }
  } else {
    console.log('  \x1b[33m⚠ NOTICE\x1b[0m No DSEX records currently in staging DB (run `npm run build:dsex` to stage).');
  }

  const overallPassed = priceAuditPassed && fundAuditPassed && dsexAuditPassed && totalErrors === 0;
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
    JSON.stringify({ priceAuditPassed, fundAuditPassed, dsexAuditPassed, totalErrors, totalWarnings })
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
