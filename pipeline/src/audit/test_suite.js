import { DataAuditor } from '../../../shared/data_auditor.js';

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

  // Test 1: Price History Auditor - valid records pass through, change derived from real ycp
  console.log('1. Testing Data Auditor Price History Validation...');
  const sampleHistory = [
    { date: '2026-08-18', close: 54.2, ycp: 53.8, volume: 125000 },
    { date: '2026-08-19', close: 55.1, ycp: 54.2, volume: 98000 },
    { date: '2026-08-20', close: 54.9, ycp: 55.1, volume: 143000 }
  ];
  const auditRes = DataAuditor.auditPriceHistory('BRACBANK', sampleHistory);
  assert(auditRes.passed === true, 'Valid price history passed all audit constraints');
  assert(auditRes.cleaned.length === sampleHistory.length, `Cleaned count (${auditRes.cleaned.length}) matches input without drops`);
  assert(auditRes.cleaned[0].change === Number((54.2 - 53.8).toFixed(2)), 'Change correctly derived from real close - ycp');

  // Test 2: Missing ycp stays null, never fabricated as a 0% change
  console.log('\n2. Testing Null Preservation for Missing YCP...');
  const noYcpData = [{ date: '2026-08-21', close: 33.6, volume: 1000 }];
  const noYcpAudit = DataAuditor.auditPriceHistory('TESTSTOCK', noYcpData);
  assert(noYcpAudit.cleaned[0].ycp === null, 'Missing ycp preserved as null, not fabricated');
  assert(noYcpAudit.cleaned[0].change === null, 'Change correctly stays null when ycp is unknown');

  // Test 3: Duplicate Date Filtering
  console.log('\n3. Testing Duplicate Date Protection in Auditor...');
  const dirtyData = [
    { date: '2026-08-20', close: 33.6, volume: 1000 },
    { date: '2026-08-20', close: 33.6, volume: 1000 }, // Duplicate
    { date: '2026-08-21', close: 34.0, volume: 2000 }
  ];
  const dirtyAudit = DataAuditor.auditPriceHistory('TESTSTOCK', dirtyData);
  assert(dirtyAudit.cleaned.length === 2, 'Correctly eliminated 1 duplicate date (2 clean remaining)');

  // Test 4: DSEX Benchmark Auditor - realistic range enforcement
  console.log('\n4. Testing DSEX Macro Benchmark Auditor...');
  const dsexSample = [
    { date: '2026-08-18', index_value: 5773.63 },
    { date: '2026-08-19', index_value: 5769.71 },
    { date: '2026-08-20', index_value: 5786.08 },
    { date: '2026-08-21', index_value: 99999 } // out of realistic range
  ];
  const dsexAudit = DataAuditor.auditDSEXHistory(dsexSample);
  assert(dsexAudit.cleaned.length === 3, 'Out-of-range DSEX value correctly rejected');
  assert(dsexAudit.errors.length === 1, 'Out-of-range DSEX value flagged as an error');

  // Test 5: Financial Statements Auditor - ROE derived only from real eps/navps
  console.log('\n5. Testing Financial Statements Auditor...');
  const stmtSample = [
    { year: 2025, eps: 21.5, navps: 110.0, dividend_yield: 4.2 },
    { year: 2024, eps: 19.8, navps: 102.3 }
  ];
  const stmtsAudit = DataAuditor.auditFinancialStatements('SQURPHARMA', stmtSample);
  assert(stmtsAudit.passed === true, 'Financial statements passed audit checks');
  assert(stmtsAudit.cleaned[0].year === 2025, 'Latest statement is FY2025');
  assert(stmtsAudit.cleaned[0].roe === Number(((21.5 / 110.0) * 100).toFixed(2)), 'ROE correctly derived from real eps/navps');
  assert(stmtsAudit.cleaned[1].dps === null, 'Undisclosed DPS stays null, not fabricated as 0');

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
