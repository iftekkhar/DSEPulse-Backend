import { DataAuditor } from './auditor.js';
import { buildStock20YearHistory } from '../builders/history_builder.js';
import { build20YearDSEXIndex } from '../builders/dsex_builder.js';
import { build20YearAuditedStatements } from '../builders/fundamentals_builder.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m ${testName}`);
    passedTests++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${testName}`);
    failedTests++;
  }
}

async function runPipelineTestSuite() {
  console.log('\n======================================================');
  console.log('   DSEPULSE-PIPELINE INSTITUTIONAL TEST SUITE');
  console.log('======================================================\n');

  // Test 1: 20-Year History Builder
  console.log('1. Testing 20-Year Stock History Builder...');
  const testHistory = buildStock20YearHistory('BRACBANK', { ltp: 55.4, eps: 5.2, pe: 10.6 });
  assert(testHistory.length >= 1500, `Generated ${testHistory.length} trading sessions (expected >= 1500)`);
  assert(testHistory[0].date.startsWith('2005'), `Earliest record starts in 2005 (${testHistory[0].date})`);
  assert(testHistory[testHistory.length - 1].close > 0, `Latest closing price is positive (${testHistory[testHistory.length - 1].close})`);

  // Test 2: Auditor on Price History
  console.log('\n2. Testing Data Auditor Price History Validation...');
  const auditRes = DataAuditor.auditPriceHistory('BRACBANK', testHistory);
  assert(auditRes.passed === true, 'Price history passed all audit constraints');
  assert(auditRes.cleaned.length === testHistory.length, `Cleaned count (${auditRes.cleaned.length}) matches input without drops`);

  // Test 3: Duplicate Date Filtering
  console.log('\n3. Testing Duplicate Date Protection in Auditor...');
  const dirtyData = [
    { date: '2026-08-20', close: 33.6, volume: 1000 },
    { date: '2026-08-20', close: 33.6, volume: 1000 }, // Duplicate
    { date: '2026-08-21', close: 34.0, volume: 2000 }
  ];
  const dirtyAudit = DataAuditor.auditPriceHistory('TESTSTOCK', dirtyData);
  assert(dirtyAudit.cleaned.length === 2, `Correctly eliminated 1 duplicate date (2 clean remaining)`);

  // Test 4: 20-Year DSEX Index Builder & Auditor
  console.log('\n4. Testing 20-Year DSEX Macro Benchmark Builder...');
  const dsexTimeline = build20YearDSEXIndex();
  assert(dsexTimeline.length >= 1500, `Generated ${dsexTimeline.length} DSEX sessions (expected >= 1500)`);
  const dsexAudit = DataAuditor.auditDSEXHistory(dsexTimeline);
  assert(dsexAudit.passed === true, 'DSEX benchmark timeline passed institutional audit');
  assert(dsexAudit.cleaned.some(p => p.dsexIndex > 8000), '2010 super bubble peak recorded in DSEX (> 8,000 pts)');

  // Test 5: 20-Year Audited Financial Statements
  console.log('\n5. Testing 20-Year Audited Financial Statements Builder...');
  const stmts = build20YearAuditedStatements('SQURPHARMA', { eps: 21.5, navps: 110.0, roe: 19.5, dividend_yield: 4.2 });
  assert(stmts.length === 21, `Constructed exactly 21 annual disclosures (FY2005-FY2025)`);
  const stmtsAudit = DataAuditor.auditFinancialStatements('SQURPHARMA', stmts);
  assert(stmtsAudit.passed === true, 'Financial statements passed audit checks');
  assert(stmtsAudit.cleaned[0].year === 2025, 'Latest statement is FY2025');
  assert(stmtsAudit.cleaned[stmtsAudit.cleaned.length - 1].year === 2005, 'Earliest statement is FY2005');

  console.log('\n======================================================');
  console.log(`TEST SUMMARY: ${passedTests} Passed, ${failedTests} Failed`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPipelineTestSuite().catch(err => {
  console.error('Test Suite encountered fatal error:', err);
  process.exit(1);
});
