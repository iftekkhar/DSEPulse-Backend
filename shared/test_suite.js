/**
 * Extensive test cases for the shared foundation every scraper and DB-write path
 * now depends on: the canonical null/number rule (safe_number.js), the audit
 * gates (data_auditor.js), the scraper kill-switch (scraper_registry.js), and the
 * highest-risk pure parsing logic pulled out of the scrapers themselves
 * (fundamentals_scraper.js's multi-group table resolution). Run via `npm test`
 * from the repo root. See docs/AUDIT_RULES.md for the policy this enforces.
 */
import { numOrNull, positiveNumOrNull, deriveOrNull, sumTerm, roundOrNull } from './safe_number.js';
import { DataAuditor } from './data_auditor.js';
import { SCRAPER_REGISTRY, isScraperEnabled, listScrapers } from './scraper_registry.js';
import { lastNumberInGroup, headlineOrContinuing } from '../pipeline/src/scrapers/fundamentals_scraper.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m ${testName}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${testName}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. safe_number.js -- numOrNull');
// ─────────────────────────────────────────────────────────────────────────────
assert(numOrNull(null) === null, 'null stays null');
assert(numOrNull(undefined) === null, 'undefined stays null');
assert(numOrNull('') === null, 'empty string stays null');
assert(numOrNull('-') === null, 'lone dash (DSE\'s "no data" marker) stays null');
assert(numOrNull('N/A') === null, '"N/A" stays null');
assert(numOrNull('n/a') === null, 'lowercase "n/a" stays null');
assert(numOrNull('abc') === null, 'unparseable string stays null');
assert(numOrNull(0) === 0, 'real 0 is preserved as 0, NOT coerced to null');
assert(numOrNull('0') === 0, 'string "0" is preserved as 0');
assert(numOrNull(55.4) === 55.4, 'real number passes through unchanged');
assert(numOrNull('1,234.56') === 1234.56, 'comma-formatted string parses correctly');
assert(numOrNull('  42  ') === 42, 'whitespace is trimmed');

section('2. safe_number.js -- positiveNumOrNull');
assert(positiveNumOrNull(0) === null, '0 is rejected (P/E, paid-up capital, price can never legitimately be exactly 0)');
assert(positiveNumOrNull(-5) === null, 'negative is rejected');
assert(positiveNumOrNull(12.5) === 12.5, 'positive value passes through');
assert(positiveNumOrNull(null) === null, 'null stays null');

section('3. safe_number.js -- deriveOrNull (the only sanctioned "borrow from another field" mechanism)');
assert(Math.abs(deriveOrNull(55.4, 53.8, (c, y) => c - y) - 1.6) < 1e-9, 'derives from two real values');
assert(deriveOrNull(null, 53.8, (c, y) => c - y) === null, 'null first arg -> null result, not a fabricated derivation');
assert(deriveOrNull(55.4, null, (c, y) => c - y) === null, 'null second arg -> null result');
assert(deriveOrNull(null, null, (c, y) => c - y) === null, 'both null -> null');

section('4. safe_number.js -- sumTerm (the ONE sanctioned ?? 0 exception, for loop accumulators only)');
assert(sumTerm(null) === 0, 'null contributes 0 to a running sum');
assert(sumTerm(undefined) === 0, 'undefined contributes 0 to a running sum');
assert(sumTerm(150000) === 150000, 'real value passes through for summing');
assert(sumTerm(0) === 0, 'real 0 still sums as 0 (same result, correct either way)');

section('5. safe_number.js -- roundOrNull');
assert(roundOrNull(1.23456, 2) === 1.23, 'rounds to given precision');
assert(roundOrNull(null) === null, 'null stays null through rounding');

// ─────────────────────────────────────────────────────────────────────────────
section('6. data_auditor.js -- auditPriceHistory (regression: the ycp-fabrication bug class)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const sample = [
    { date: '2026-08-18', close: 54.2, ycp: 53.8, volume: 125000 },
    { date: '2026-08-19', close: 55.1, ycp: 54.2, volume: 98000 },
  ];
  const r = DataAuditor.auditPriceHistory('TEST', sample);
  assert(r.passed === true, 'valid records pass');
  assert(r.cleaned[0].change !== null, 'change derived when ycp is real');

  const noYcp = DataAuditor.auditPriceHistory('TEST', [{ date: '2026-08-20', close: 33.6 }]);
  assert(noYcp.cleaned[0].ycp === null, 'missing ycp preserved as null');
  assert(noYcp.cleaned[0].change === null, 'change stays null rather than computing close - close');

  const badClose = DataAuditor.auditPriceHistory('TEST', [{ date: '2026-08-21', close: 0 }]);
  assert(badClose.passed === false, 'a close of exactly 0 is a hard error, not a valid price');
}

section('7. data_auditor.js -- auditFinancialStatements (regression: the fundamentals_history !== undefined bug)');
{
  const r = DataAuditor.auditFinancialStatements('TEST', [
    { year: 2025, eps: 21.5, navps: 110.0 },
    { year: 2024, eps: 19.8, navps: null, pe_ratio: null, paid_up_capital_mn: null },
  ]);
  assert(r.passed === true, 'valid statements pass');
  assert(r.cleaned[0].roe !== null, 'ROE derived from real eps/navps');
  assert(r.cleaned[1].navps === null, 'undisclosed navps stays null, not fabricated as 0');
  assert(r.cleaned[1].pe_ratio === null, 'undisclosed P/E stays null -- this exact field was the live incident');
  assert(r.cleaned[1].paid_up_capital_mn === null, 'undisclosed paid_up_capital_mn stays null -- this exact field was the live incident');
}

section('8. data_auditor.js -- auditDSEXHistory');
{
  const r = DataAuditor.auditDSEXHistory([
    { date: '2026-08-18', index_value: 5773.63 },
    { date: '2026-08-19', index_value: 99999 },
  ]);
  assert(r.cleaned.length === 1, 'out-of-range DSEX rejected, valid one kept');
  assert(r.errors.length === 1, 'out-of-range flagged as an error');
}

section('9. data_auditor.js -- auditMarketBreadthSnapshot (Job 1 / Job 4\'s previously-unguarded write path)');
{
  const good = DataAuditor.auditMarketBreadthSnapshot({ dsexIndex: 5786.08, advancing: 165, declining: 148, unchanged: 67 });
  assert(good.passed === true, 'realistic snapshot passes');

  const fabricated = DataAuditor.auditMarketBreadthSnapshot({ dsexIndex: 5786.08, advancing: 180, declining: 140, unchanged: 60 });
  assert(fabricated.passed === false, 'the exact dsex_builder.js fabrication signature (180/140/60) is a hard error');

  const outOfRange = DataAuditor.auditMarketBreadthSnapshot({ dsexIndex: 999999 });
  assert(outOfRange.passed === false, 'DSEX outside 500-20000 is a hard error');
}

section('10. data_auditor.js -- auditCompanyListRecord (regression: the face_value=10 assumption)');
{
  const good = DataAuditor.auditCompanyListRecord({ symbol: 'BRACBANK', face_value: 10, total_shares: 1000000 });
  assert(good.passed === true, 'valid record passes');

  const unknownFaceValue = DataAuditor.auditCompanyListRecord({ symbol: 'NEWCO', face_value: null, total_shares: null });
  assert(unknownFaceValue.passed === true, 'a genuinely-unknown face_value is valid (null), not an error');
  assert(unknownFaceValue.cleaned.face_value === null, 'stays null -- never silently assumed as 10');

  const badFaceValue = DataAuditor.auditCompanyListRecord({ symbol: 'BADCO', face_value: -5 });
  assert(badFaceValue.passed === false, 'a negative face_value is rejected outright');

  const noSymbol = DataAuditor.auditCompanyListRecord({ face_value: 10 });
  assert(noSymbol.passed === false, 'a record with no symbol is rejected');
}

// ─────────────────────────────────────────────────────────────────────────────
section('11. scraper_registry.js -- every scraper defaults OFF');
// ─────────────────────────────────────────────────────────────────────────────
{
  const all = listScrapers();
  assert(all.length > 0, `registry has entries (${all.length} scrapers listed)`);
  const anyEnabled = all.some(s => s.enabled === true);
  assert(anyEnabled === false, 'not a single scraper is enabled by default -- this is the literal "turn them all off" requirement');
  assert(isScraperEnabled('server.closing_prices') === false, 'a known key reads as disabled');
  assert(isScraperEnabled('totally.unknown.key') === false, 'an unknown key fails closed (disabled), not open');
}

// ─────────────────────────────────────────────────────────────────────────────
section('12. fundamentals_scraper.js -- lastNumberInGroup / headlineOrContinuing (DSE\'s multi-group table layout)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // A company with no discontinued operations: headline group (0-2) is all dashes,
  // Continuing-Operations group (3-5) has the real EPS -- the overwhelming normal case.
  const normalCase = ['-', '-', '-', '4.12', '-', '-', '25.60', '-', '-'];
  assert(headlineOrContinuing(normalCase) === 4.12, 'falls back to Continuing-Operations group when headline is entirely dashed');
  assert(lastNumberInGroup(normalCase, 6) === 25.6, 'NAV Per Share group (cells 6-8) resolved correctly');

  // A company that DOES report discontinued operations: headline group has the value.
  const headlineCase = ['9.87', '-', '-', '4.12', '-', '-'];
  assert(headlineOrContinuing(headlineCase) === 9.87, 'headline group takes priority when it has a real value');

  // Restated supersedes Original within a group -- "last non-dash wins".
  const restatedCase = ['5.00', '5.25', '-']; // Original=5.00, Restated=5.25, Diluted=dash
  assert(lastNumberInGroup(restatedCase, 0) === 5.25, 'Restated value supersedes Original within the same group');

  // All-dash group (company hasn't disclosed this line at all).
  assert(lastNumberInGroup(['-', '-', '-'], 0) === null, 'an entirely-dashed group resolves to null, not 0');
  assert(headlineOrContinuing(['-', '-', '-', '-', '-', '-']) === null, 'both groups dashed -> null, not fabricated');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n======================================================');
console.log(`SHARED TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('======================================================\n');

if (failed > 0) process.exit(1);
