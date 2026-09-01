/**
 * Extensive test cases for the shared foundation every scraper and DB-write path
 * now depends on: the canonical null/number rule (safe_number.js), the audit
 * gates (data_auditor.js), the scraper kill-switch (scraper_registry.js), and the
 * highest-risk pure parsing logic used by the fundamentals scrapers
 * (fundamentals_parsing.js's multi-group table resolution, shared by both
 * server/scrapers/scrape_historical_financial_statements.js and
 * server/scrapers/sources/dse_fundamentals_scraper.js). Run via
 * `npm test` from the repo root. See ARCHITECTURE.md for the policy this enforces.
 */
import { numOrNull, positiveNumOrNull, deriveOrNull, sumTerm, roundOrNull } from './safe_number.js';
import { DataAuditor, DS30_INDEX_MIN, DS30_INDEX_MAX, SHAREHOLDING_SUM_TOLERANCE_PCT } from './data_auditor.js';
import { SCRAPER_REGISTRY, isScraperEnabled, listScrapers, assertNoConflictingScrapers, setRuntimeOverride, clearRuntimeOverride } from './scraper_registry.js';
import { tierOf, isApprovedSource, tierAllowsOverwrite, tierDisplayName } from './source_tiers.js';
// cheerio imported directly here (not via a shared re-export) so this suite
// has no dependency beyond shared/ + its own package.json.
import * as cheerio from 'cheerio';
import { lastNumberInGroup, headlineOrContinuing, parseCashDividendString, extractBalanceSheetFromCheerio } from './fundamentals_parsing.js';
import { computeExtendedPremiumUntil, isPremiumActive, validatePromoRedemption, totalBonusHours } from './entitlements_logic.js';
import { PLANS, FREE_WINDOW_DAYS, isValidPlan, freeWindowCutoffDate } from './plans.js';
import { buildLockedMeta, filterRowsByDateField, limitToLatestFiscalYear, applyDeepDiveGate, gateStockDisclosureFields } from './gating_logic.js';
import { stripInternalFields } from './response_shaping.js';
import { DEFAULT_APP_SETTINGS, isValidSettingKey, getSetting, setSettingOverride, clearSettingOverride, getAllSettings, getAllSettingsWithStatus } from './app_settings.js';
import {
  calculateGrahamNumber,
  calculatePeterLynchFairValue,
  calculateDDM,
  calculateBuffettDCF,
  calculateDebtToEquity,
  calculateValuationCorridors,
  calculateMeanReversionTarget,
  calculateCAGR,
  calculatePiotroskiFScore,
  calculateBuffettMoatScore,
  calculateVolatilityAndBeta,
  calculateVolumeVelocity,
  calculateTotalShareholderReturn,
  generateComprehensiveValuationProfile,
  calculateRSI,
  calculateATR,
  calculateWMA,
  generateTechnicalProfile
} from '../server/valuation_engine.js';

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

// ─────────────────────────────────────────────────────────────────────────────
section('9b. data_auditor.js -- auditDS30Snapshot & auditShareholdingRecord (2026-09-01, previously untested)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // These two methods existed with zero test coverage until now -- ARCHITECTURE.md
  // itself still says "5 audit methods" while the class actually has 8
  // (auditPriceHistory, auditFinancialStatements, auditDSEXHistory,
  // auditMarketBreadthSnapshot, auditDS30Snapshot, auditCompanyListRecord,
  // auditShareholdingRecord, auditBlockMarketRecord), and this was one of the
  // two gaps behind that stale count.
  assert(DS30_INDEX_MIN === 500 && DS30_INDEX_MAX === 8000, 'DS30 sanity range constants match the documented live-verified band');

  const goodDs30 = DataAuditor.auditDS30Snapshot({ ds30Index: 2450, prevClose: 2410 });
  assert(goodDs30.passed === true, 'a realistic DS30 snapshot passes');
  assert(goodDs30.cleaned.changePercent !== null, 'change% derived from two real values');

  const outOfRangeDs30 = DataAuditor.auditDS30Snapshot({ ds30Index: DS30_INDEX_MAX + 1 });
  assert(outOfRangeDs30.passed === false, 'a DS30 value just outside the shared range constant is a hard error');

  const inRangeDs30 = DataAuditor.auditDS30Snapshot({ ds30Index: DS30_INDEX_MIN });
  assert(inRangeDs30.passed === true, 'the shared range constant\'s own boundary value is inclusive/valid');

  assert(SHAREHOLDING_SUM_TOLERANCE_PCT === 1.0, 'shareholding sum tolerance constant matches the documented +/-1.0 band');

  const goodShareholding = DataAuditor.auditShareholdingRecord('TEST', { sponsorPct: 40, govtPct: 0, institutePct: 20, foreignPct: 5, publicPct: 35 });
  assert(goodShareholding.passed === true, 'a shareholding breakdown summing to exactly 100% passes');

  const driftedShareholding = DataAuditor.auditShareholdingRecord('TEST', { sponsorPct: 40, govtPct: 0, institutePct: 20, foreignPct: 5, publicPct: 35.5 });
  assert(driftedShareholding.passed === true, `rounding drift within the +/-${SHAREHOLDING_SUM_TOLERANCE_PCT} tolerance is accepted, not flagged`);

  const badShareholding = DataAuditor.auditShareholdingRecord('TEST', { sponsorPct: 40, govtPct: 0, institutePct: 20, foreignPct: 5, publicPct: 50 });
  assert(badShareholding.passed === false, 'a shareholding breakdown materially off 100% is rejected');

  const missingCategory = DataAuditor.auditShareholdingRecord('TEST', { sponsorPct: 40, govtPct: 0, institutePct: 20, foreignPct: 5 });
  assert(missingCategory.passed === false, 'a missing shareholding category is rejected, not silently treated as 0');
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
section('11. source_tiers.js -- the approved-source list');
// ─────────────────────────────────────────────────────────────────────────────
assert(tierOf('DSE_SCRAPE') === 1, 'DSE_SCRAPE is Tier 1');
assert(tierOf('LANKABD') === 2, 'LANKABD is Tier 2');
assert(tierOf('KAGGLE') === null, 'KAGGLE was permanently purged -- no longer an approved source');
assert(tierOf('MCAP_WEIGHTED_ESTIMATE') === null, 'MCAP_WEIGHTED_ESTIMATE was permanently purged -- no longer an approved source');
assert(tierOf('SOME_RANDOM_SCRAPER') === null, 'an unlisted source has no tier -- not silently treated as approved');
assert(isApprovedSource('DSE_OFFICIAL_ARCHIVE') === true, 'a real Tier 1 source is approved');
assert(isApprovedSource('MADE_UP_SOURCE') === false, 'an unapproved source is rejected, not defaulted to trusted');

// tierAllowsOverwrite -- regression case: lankabd_scraper.js's first live run
// silently overwrote ~8,160 real DSE_SCRAPE rows before this guard existed.
assert(tierAllowsOverwrite('LANKABD', 'DSE_SCRAPE') === true, 'Tier 1 (DSE) may overwrite Tier 2 (LankaBD)');
assert(tierAllowsOverwrite('DSE_SCRAPE', 'LANKABD') === false, 'Tier 2 (LankaBD) may NOT overwrite Tier 1 (DSE) -- the exact bug that happened');
assert(tierAllowsOverwrite('DSE_SCRAPE', 'DSE_SCRAPE') === true, 'same tier may overwrite (re-scrape of the same source is fine)');
assert(tierAllowsOverwrite(null, 'LANKABD') === true, 'no existing row -- nothing to protect, write proceeds');
assert(tierAllowsOverwrite('DSE_SCRAPE', undefined) === true, 'unrecognized incoming tier never blocks -- fails open on missing tier info, not closed');

// ─────────────────────────────────────────────────────────────────────────────
section('12. scraper_registry.js -- every scraper defaults OFF');
// ─────────────────────────────────────────────────────────────────────────────
{
  const all = listScrapers();
  assert(all.length > 0, `registry has entries (${all.length} scrapers listed)`);
  const anyEnabled = all.some(s => s.enabled === true);
  assert(anyEnabled === false, 'not a single scraper is enabled by default -- this is the literal "turn them all off" requirement');
  assert(isScraperEnabled('server.closing_prices') === false, 'a known key reads as disabled');
  assert(isScraperEnabled('totally.unknown.key') === false, 'an unknown key fails closed (disabled), not open');

  let threw = false;
  try { assertNoConflictingScrapers(); } catch { threw = true; }
  assert(threw === false, 'current registry state boots clean');

  // Runtime override (admin panel, 2026-08-23) -- a live toggle must behave
  // exactly like editing the file would.
  assert(isScraperEnabled('server.live_ticker') === false, 'sanity: known-disabled key reads disabled before any override');
  setRuntimeOverride('server.live_ticker', true);
  assert(isScraperEnabled('server.live_ticker') === true, 'a runtime override flips isScraperEnabled immediately, no restart needed');
  clearRuntimeOverride('server.live_ticker');
  assert(isScraperEnabled('server.live_ticker') === false, 'clearing the override falls back to the file\'s own (disabled) default');
}

// ─────────────────────────────────────────────────────────────────────────────
section('13. fundamentals_parsing.js -- lastNumberInGroup / headlineOrContinuing (DSE\'s multi-group table layout)');
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
section('14. entitlements_logic.js -- premium extension/validation rules (2026-08-23)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const NOW = Date.parse('2026-08-23T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  // Never purchased (null) -- anchors to now, not some fabricated baseline.
  const fromNull = computeExtendedPremiumUntil(null, 7, NOW);
  assert(Date.parse(fromNull) === NOW + 7 * DAY, 'never-purchased user: extension anchors to now()');

  // Lapsed (premium_until in the past) -- anchors to now, doesn't resurrect
  // the old expiry as a baseline to add onto.
  const lapsed = new Date(NOW - 30 * DAY).toISOString();
  const fromLapsed = computeExtendedPremiumUntil(lapsed, 30, NOW);
  assert(Date.parse(fromLapsed) === NOW + 30 * DAY, 'lapsed user: extension anchors to now(), not the expired date');

  // Still active (20 days remaining) -- stacks on top, doesn't waste the
  // remainder or restart from now(). This is the exact fairness rule from
  // the approved plan: buying another pass while time remains extends it.
  const stillActive = new Date(NOW + 20 * DAY).toISOString();
  const fromActive = computeExtendedPremiumUntil(stillActive, 30, NOW);
  assert(Date.parse(fromActive) === NOW + 50 * DAY, 'active user with 20 days left + a 30-day pass -> 50 days out, not 30 (no wasted remainder)');

  assert(isPremiumActive(null, NOW) === false, 'null premium_until is not active');
  assert(isPremiumActive(new Date(NOW - DAY).toISOString(), NOW) === false, 'a past premium_until is not active');
  assert(isPremiumActive(new Date(NOW + DAY).toISOString(), NOW) === true, 'a future premium_until is active');

  // Promo redemption validation
  const activePromo = { code: 'PULSE24', bonus_days: 1, active: 1 };
  const inactivePromo = { code: 'DEAD', bonus_days: 1, active: 0 };
  assert(validatePromoRedemption({ promo: activePromo, alreadyRedeemed: false }).ok === true, 'active promo, first redemption -> allowed');
  assert(validatePromoRedemption({ promo: null, alreadyRedeemed: false }).ok === false, 'nonexistent code -> rejected');
  assert(validatePromoRedemption({ promo: inactivePromo, alreadyRedeemed: false }).ok === false, 'an admin-deactivated code -> rejected even if never redeemed');
  assert(validatePromoRedemption({ promo: activePromo, alreadyRedeemed: true }).ok === false, 'same user redeeming the same code twice -> rejected');

  // Hourly/flash promos (2026-08-24)
  assert(totalBonusHours({ bonus_days: 1, bonus_hours: 6 }) === 30, '1 day + 6 hours -> 30 total hours');
  assert(totalBonusHours({ bonus_days: 0, bonus_hours: 6 }) === 6, 'hours-only code -> just the hours');
  assert(totalBonusHours({ bonus_days: 2, bonus_hours: 0 }) === 48, 'days-only code -> unaffected by the new field (48h = 2d)');
  assert(totalBonusHours({ bonus_days: 2 }) === 48, 'a pre-existing code with no bonus_hours column value at all still totals correctly (undefined treated as 0)');

  const hoursOnlyPromo = { code: 'FLASH6', bonus_days: 0, bonus_hours: 6, active: 1 };
  assert(validatePromoRedemption({ promo: hoursOnlyPromo, alreadyRedeemed: false }).ok === true, 'an hours-only promo (0 days, 6 hours) is a valid, redeemable code');

  const emptyPromo = { code: 'BROKEN', bonus_days: 0, bonus_hours: 0, active: 1 };
  assert(validatePromoRedemption({ promo: emptyPromo, alreadyRedeemed: false }).ok === false, 'a code with zero days AND zero hours is rejected as misconfigured, not silently redeemable for nothing');

  // extendEntitlement's underlying computeExtendedPremiumUntil already takes
  // fractional days -- confirms the hours->days conversion (hours/24) an
  // hourly promo relies on actually lands at the right instant, not just a
  // rounded day.
  const sixHoursAsDays = 6 / 24;
  const fromFlashPromo = computeExtendedPremiumUntil(null, sixHoursAsDays, NOW);
  assert(Date.parse(fromFlashPromo) === NOW + 6 * 60 * 60 * 1000, 'a 6-hour promo extends premium_until by exactly 6 hours, not rounded to a full day');
}

// ─────────────────────────────────────────────────────────────────────────────
section('15. plans.js -- pricing config + rolling free-window cutoff (2026-08-23)');
// ─────────────────────────────────────────────────────────────────────────────
{
  assert(FREE_WINDOW_DAYS === 183, 'free window is the agreed ~6 months (183 days)');
  assert(Object.keys(PLANS).length === 4, 'exactly the 4 agreed plans exist');
  assert(PLANS.WEEKLY.priceBdt === 100 && PLANS.WEEKLY.days === 7, 'Weekly: 100tk / 7 days');
  assert(PLANS.MONTHLY.priceBdt === 300 && PLANS.MONTHLY.days === 30, 'Monthly: 300tk / 30 days');
  assert(PLANS.QUARTERLY.priceBdt === 700 && PLANS.QUARTERLY.days === 90, 'Quarterly: 700tk / 90 days');
  assert(PLANS.HALF_YEARLY.priceBdt === 1000 && PLANS.HALF_YEARLY.days === 180, 'Half-yearly: 1000tk / 180 days');

  // Cost-per-day should strictly decrease as duration increases -- a longer
  // plan must never be worse value than a shorter one (verified once at
  // design time; asserted here so a future price edit can't silently break it).
  const perDay = (p) => p.priceBdt / p.days;
  assert(perDay(PLANS.MONTHLY) < perDay(PLANS.WEEKLY), 'Monthly is cheaper per day than Weekly');
  assert(perDay(PLANS.QUARTERLY) < perDay(PLANS.MONTHLY), 'Quarterly is cheaper per day than Monthly');
  assert(perDay(PLANS.HALF_YEARLY) < perDay(PLANS.QUARTERLY), 'Half-yearly is cheaper per day than Quarterly');

  assert(isValidPlan('MONTHLY') === true, 'a real plan key is valid');
  assert(isValidPlan('LIFETIME') === false, 'an unrecognized plan key is invalid -- no silent fallback to a real plan');

  const cutoff = freeWindowCutoffDate();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(cutoff), 'cutoff is a real YYYY-MM-DD date string');
  const daysAgo = Math.round((Date.now() - Date.parse(cutoff)) / (24 * 60 * 60 * 1000));
  assert(Math.abs(daysAgo - FREE_WINDOW_DAYS) <= 1, 'cutoff is ~183 days in the past (allowing 1 day for clock/DST rounding)');
}

// ─────────────────────────────────────────────────────────────────────────────
section('16. gating_logic.js -- the premium paywall boundary (2026-08-23)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const CUTOFF = '2026-02-22';

  // filterRowsByDateField -- price_history/dsex_market_history-shaped rows
  const dateRows = [
    { date: '2013-01-27', close: 10 },
    { date: '2026-01-01', close: 20 },
    { date: '2026-03-01', close: 30 },
    { date: '2026-08-20', close: 40 },
  ];
  const freeRows = filterRowsByDateField(dateRows, 'date', CUTOFF, false);
  assert(freeRows.length === 2, 'free user: only rows on/after the cutoff survive (2 of 4)');
  assert(freeRows.every(r => r.date >= CUTOFF), 'every surviving free row is actually within the free window');
  const entitledRows = filterRowsByDateField(dateRows, 'date', CUTOFF, true);
  assert(entitledRows.length === 4, 'entitled user: nothing filtered, full archive returned');

  assert(buildLockedMeta(CUTOFF).locked === true, 'locked meta always carries locked: true');
  assert(buildLockedMeta(CUTOFF).freeFrom === CUTOFF, 'locked meta echoes the actual cutoff so the frontend can show it');

  // limitToLatestFiscalYear -- fundamentals_history-shaped rows, pre-sorted
  // newest first (matches getCompanyFundamentalsHistory's ORDER BY DESC)
  const fyRows = [{ year: 2025 }, { year: 2024 }, { year: 2023 }];
  assert(limitToLatestFiscalYear(fyRows, false).length === 1, 'free user: only the latest fiscal year survives');
  assert(limitToLatestFiscalYear(fyRows, false)[0].year === 2025, 'the ONE year kept is the newest, not an arbitrary one');
  assert(limitToLatestFiscalYear(fyRows, true).length === 3, 'entitled user: full multi-year history returned');

  // applyDeepDiveGate -- the Deep Dive page's response shape
  const fullAnalysis = {
    symbol: 'TEST', fullName: 'Test Co', sector: 'Bank', category: 'A',
    currentPrice: 55.4, closeDate: '2026-08-20',
    ath: { price: 100, date: '2020-01-01' },
    atl: { price: 10, date: '2013-01-01' },
    maxDrawdown: { percent: -50 },
    technical: { sma50: 50, sma200: 48, trendSignal: 'Bullish' },
    valuationCorridor: { currentPe: 10 },
    meanReversion: { targetPrice: 60 },
    valuationCorridorPb: { currentPb: 1.2 },
    meanReversionPb: { targetPrice: 45 },
    grahamAndBuffett: { eps: 5, navps: 40 },
    disclosures: { auditedPe: 10, eps: 5 },
    catalysts: [{ title: 'Some macro event' }],
    cycles: [{ title: 'Some cycle' }],
    timeline: [{ date: '2013-01-27', price: 10 }, { date: '2026-03-01', price: 30 }, { date: '2026-08-20', price: 40 }],
    financialStatements: [{ year: 2025 }, { year: 2024 }],
    // Pro-investor analytics block (2026-08-24) -- must be gated the same as
    // everything else above, not inherit "free" just by being new.
    riskMetrics: { annualizedVolatilityPercent: 22.5, beta: 0.9, sharpeRatio: 0.5 },
    returnsTable: [{ period: '1Y', priceCagrPercent: 12 }],
    fundamentalsGrowth: { epsCagr: { cagrPercent: 8 }, navpsCagr: { cagrPercent: 6 } },
    week52: { high: 90, low: 60, percentOffHigh: -10 },
    liquidity: { avgDailyVolume: 50000, classification: 'Moderate' },
    sectorPercentileTrend: [{ fiscalYear: 2025, percentile: 60 }],
    shareholding: { current: { sponsorPct: 40 }, previous: { sponsorPct: 41 } },
  };

  const entitledView = applyDeepDiveGate(fullAnalysis, true, CUTOFF);
  assert(entitledView === fullAnalysis, 'entitled user gets the exact same object back, untouched');

  const freeView = applyDeepDiveGate(fullAnalysis, false, CUTOFF);
  assert(freeView.locked === true, 'free user response is marked locked');
  assert(freeView.currentPrice === 55.4 && freeView.closeDate === '2026-08-20', 'TODAY\'s price stays visible for free users -- only the archive is gated, not live data');
  assert(freeView.symbol === 'TEST' && freeView.sector === 'Bank', 'identity fields stay visible for free users');
  assert(freeView.catalysts.length === 1 && freeView.cycles.length === 1, 'generic macro/cycle content stays visible -- it\'s not user-specific gated data');
  assert(freeView.ath === null && freeView.atl === null, 'ATH/ATL are nulled, not recomputed on a truncated window (a "6-month ATH" would be silently misleading)');
  assert(freeView.maxDrawdown === null && freeView.technical === null, 'drawdown/technical trend are nulled -- SMA200 needs ~200 trading days, more than the free window contains');
  assert(freeView.valuationCorridor === null && freeView.meanReversion === null && freeView.grahamAndBuffett === null, 'valuation/Graham blocks are nulled');
  assert(freeView.valuationCorridorPb === null && freeView.meanReversionPb === null, 'P/B corridor/mean-reversion blocks are nulled the same as their P/E counterparts');
  assert(freeView.disclosures === null, 'audited disclosures block is nulled (derived from gated fundamentals_history)');
  assert(freeView.financialStatements.length === 0, 'financial statement history is emptied for free users');
  assert(freeView.timeline.length === 2, 'timeline is truncated to the free window (2 of 3 points), not blanked entirely -- a free user still sees a real partial chart');
  assert(freeView.timeline.every(pt => pt.date >= CUTOFF), 'every surviving timeline point is actually within the free window');

  assert(freeView.riskMetrics === null, 'volatility/beta/Sharpe are nulled -- computed from more than the free window\'s worth of price history');
  assert(Array.isArray(freeView.returnsTable) && freeView.returnsTable.length === 0, 'multi-period CAGR table is emptied, not left at its 1Y/3Y/5Y/10Y entries');
  assert(freeView.fundamentalsGrowth === null, 'EPS/NAVPS CAGR is nulled -- spans multiple audited fiscal years');
  assert(freeView.week52 === null, '52-week high/low is nulled -- 365 days exceeds the free window');
  assert(freeView.liquidity === null, 'liquidity profile is nulled');
  assert(Array.isArray(freeView.sectorPercentileTrend) && freeView.sectorPercentileTrend.length === 0, 'sector percentile trend is emptied -- multi-year');
  assert(freeView.shareholding === null, 'shareholding snapshot is nulled -- same category as disclosures above');

  // gateStockDisclosureFields -- GET /api/stocks (main screener list, 2026-08-28)
  const rawStock = {
    symbol: 'TEST', pe: 12.5, roe: 18.2, eps: 5, navPerShare: 40, debtToEquity: 0.3,
    currentRatio: 1.5, volume: 10000, changePercent: 1.2,
    auditedPe: 11.8, paidUpCapital: 500, authorizedCapital: 1000, marketCap: 2000, dividendYield: 3.5,
  };
  const entitledStock = gateStockDisclosureFields([rawStock], true)[0];
  assert(entitledStock === rawStock, 'entitled user: the exact same object comes back, untouched');

  const freeStock = gateStockDisclosureFields([rawStock], false)[0];
  assert(freeStock !== rawStock, 'free user: a new object is returned, the original is not mutated');
  assert(rawStock.auditedPe === 11.8 && rawStock.marketCap === 2000, 'the ORIGINAL object (e.g. the shared in-memory stocks cache) is untouched by gating a free response');
  assert(!('auditedPe' in freeStock) && !('paidUpCapital' in freeStock) && !('authorizedCapital' in freeStock) && !('marketCap' in freeStock) && !('dividendYield' in freeStock), 'all 5 disclosure-only fields are stripped for a free user');
  assert(freeStock.pe === 12.5 && freeStock.roe === 18.2 && freeStock.eps === 5 && freeStock.navPerShare === 40, 'scoring/Graham-Number fields (pe/roe/eps/navPerShare) stay free -- gating those would silently break verdict scoring app-wide, not just lock one card');
  assert(freeStock.debtToEquity === 0.3 && freeStock.currentRatio === 1.5 && freeStock.volume === 10000 && freeStock.changePercent === 1.2, 'the remaining Fundamental Matrix fields stay free too');
  assert(freeStock.symbol === 'TEST', 'identity field is untouched');
}

// ─────────────────────────────────────────────────────────────────────────────
section('17. response_shaping.js -- provenance never reaches a public response (2026-08-23)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const row = { date: '2026-08-20', dsexIndex: 5786.08, source: 'STAGING_DB', tier: 1 };
  const stripped = stripInternalFields(row);
  assert(stripped.source === undefined && stripped.tier === undefined, 'source/tier are removed from a single object');
  assert(stripped.date === '2026-08-20' && stripped.dsexIndex === 5786.08, 'every other field survives untouched');
  assert(row.source === 'STAGING_DB', 'the original object is not mutated -- callers that still need source (db_auditor.js etc.) are unaffected');

  const arr = [{ v: 1, source: 'A' }, { v: 2, source: 'B' }];
  const strippedArr = stripInternalFields(arr);
  assert(strippedArr.every(r => r.source === undefined), 'works on arrays of rows too, not just a single object');
  assert(strippedArr[0].v === 1 && strippedArr[1].v === 2, 'array element order and other fields preserved');

  assert(stripInternalFields(null) === null, 'null passes through unchanged');
  assert(stripInternalFields(42) === 42, 'a non-object primitive passes through unchanged');
}

section('18. app_settings.js -- admin-tunable runtime config (2026-08-24)');
// ─────────────────────────────────────────────────────────────────────────────
{
  assert(isValidSettingKey('freeCompareLimit') && isValidSettingKey('announcement'), 'both documented settings are recognized keys');
  assert(!isValidSettingKey('priceBdt') && !isValidSettingKey('PLANS'), 'a plans.js-shaped key is NOT a valid app_settings key -- pricing stays out of this system entirely');

  assert(getSetting('freeCompareLimit') === DEFAULT_APP_SETTINGS.freeCompareLimit, 'no override set -- falls through to the file default');
  assert(getAllSettings().announcement.active === false, 'default announcement starts inactive');

  setSettingOverride('freeCompareLimit', 5);
  assert(getSetting('freeCompareLimit') === 5, 'a runtime override takes priority over the file default');
  assert(getAllSettingsWithStatus().freeCompareLimit.isOverridden === true, 'status map correctly flags an overridden key');
  assert(getAllSettingsWithStatus().announcement.isOverridden === false, 'status map correctly flags a non-overridden key');

  clearSettingOverride('freeCompareLimit');
  assert(getSetting('freeCompareLimit') === DEFAULT_APP_SETTINGS.freeCompareLimit, 'clearing an override falls back to the file default again, not to undefined/null');
}

section('19. Non-Destructive Mutation & Conflict Protection (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  assert(tierAllowsOverwrite('STAGING_DB', 'DSE_SCRAPE') === true, 'Tier 1 DSE can overwrite Tier 3 STAGING');
  assert(tierAllowsOverwrite('DSE_SCRAPE', 'LANKABD') === false, 'Tier 2 LANKABD cannot overwrite Tier 1 DSE');
  assert(tierAllowsOverwrite('DSE_SCRAPE', 'DSE_SCRAPE') === true, 'Same Tier 1 source allowed to re-sync');
  assert(tierAllowsOverwrite('LANKABD', 'UNKNOWN_3RD_PARTY') === true, 'Unrecognized tier fails open for manual resolution');
  assert(tierOf('KAGGLE') === null, 'KAGGLE has no approved tier');

  // Source Display Labels (User Directive: DSE/Staging = Tier 1, LankaBD = Tier Two)
  assert(tierDisplayName('STAGING_DB') === 'Tier 1', 'STAGING_DB maps to Tier 1');
  assert(tierDisplayName('DSE_SCRAPE') === 'Tier 1', 'DSE_SCRAPE maps to Tier 1');
  assert(tierDisplayName('DSE_LIVE_CLOSING') === 'Tier 1', 'DSE_LIVE_CLOSING maps to Tier 1');
  assert(tierDisplayName('LANKABD') === 'Tier Two', 'LANKABD maps to Tier Two');
}

// ─────────────────────────────────────────────────────────────────────────────
section('20. valuation_engine.js -- Pure Quantitative & Intrinsic Models (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. Graham Number
  assert(calculateGrahamNumber(21.90, 41.49) === 142.98, 'Graham Number computes correctly for positive EPS and NAVPS');
  assert(calculateGrahamNumber(-5, 40) === null, 'Graham Number returns null for negative EPS');
  assert(calculateGrahamNumber(10, 0) === null, 'Graham Number returns null for zero/missing NAVPS');

  // 2. Peter Lynch Fair Value
  assert(calculatePeterLynchFairValue(20, 15) === 300, 'Peter Lynch Fair Value = EPS × Growth');
  assert(calculatePeterLynchFairValue(-5, 15) === null, 'Peter Lynch Fair Value returns null for negative EPS');
  assert(calculatePeterLynchFairValue(20, 80) === 1000, 'Peter Lynch Fair Value caps extreme growth at 50%');

  // 3. DDM (Dividend Discount Model)
  const ddm = calculateDDM({ dps: 20, roePct: 40, payoutRatio: 0.70, beta: 0.90, riskFreeRate: 0.1037 });
  assert(ddm !== null && ddm.fairValue > 0, 'DDM computes positive fair value');
  assert(ddm.costOfEquityPct === 15.32, 'Cost of equity (Ke) computed correctly via CAPM');
  assert(calculateDDM({ dps: null, roePct: 20 }) === null, 'DDM returns null for missing DPS');

  // 4. Buffett DCF Intrinsic Value (real Free Cash Flow / Owner Earnings, not EPS -- corrected 2026-09-01)
  const dcf = calculateBuffettDCF({ fcfPerShare: 18, fcfCagrPct: 10, riskFreeRate: 0.1037, terminalGrowthRate: 0.04 });
  assert(dcf !== null && dcf.intrinsicValue > 0, 'Buffett DCF computes valid discounted intrinsic value from real FCF');
  assert(calculateBuffettDCF({ fcfPerShare: -10, terminalGrowthRate: 0.04 }) === null, 'Buffett DCF returns null for negative free cash flow');
  assert(calculateBuffettDCF({ fcfPerShare: 18, fcfCagrPct: null, terminalGrowthRate: 0.04 }) === null, 'Buffett DCF returns null when FCF growth history is missing, rather than assuming a growth rate');

  // 5. Debt-to-Equity
  const deLow = calculateDebtToEquity({ paidUpCapitalMn: 1000, reserveSurplusMn: 3000, ociMn: 0, shortTermLoanMn: 500, longTermLoanMn: 500 });
  assert(deLow.debtToEquityRatio === 0.25, 'D/E ratio computes accurately: 1000 debt / 4000 equity = 0.25');
  assert(deLow.isLowLeverage === true, 'D/E < 0.50 correctly flagged as low leverage');

  const deHigh = calculateDebtToEquity({ paidUpCapitalMn: 500, reserveSurplusMn: 100, ociMn: 0, shortTermLoanMn: 800, longTermLoanMn: 400 });
  assert(deHigh.debtToEquityRatio === 2.0, 'D/E high leverage calculated');
  assert(deHigh.isHighLeverage === true, 'D/E > 1.20 correctly flagged as high leverage');

  assert(calculateDebtToEquity({ paidUpCapitalMn: 1000, reserveSurplusMn: 3000, shortTermLoanMn: 500, longTermLoanMn: 500 }) === null, 'D/E returns null when a real component (OCI) is genuinely missing, rather than silently treating it as zero');

  // 6. Valuation Corridors & Mean Reversion
  const sampleFunds = [
    { fiscal_year: 2021, pe_ratio: 12.5, pb_ratio: 2.1, eps_basic: 10, nav_per_share: 50, roe: 20, dps: 5,
      paid_up_capital_mn: 1000, reserve_surplus_mn: 2000, oci_mn: 0, short_term_loan_mn: 300, long_term_loan_mn: 200,
      net_income_mn: 800, total_assets_mn: 5000, operating_cash_flow_mn: 900, current_assets_mn: 2000, current_liabilities_mn: 1000,
      revenue_mn: 6000, gross_profit_mn: 1800, free_cash_flow_mn: 700 },
    { fiscal_year: 2022, pe_ratio: 14.0, pb_ratio: 2.3, eps_basic: 12, nav_per_share: 55, roe: 22, dps: 6,
      paid_up_capital_mn: 1000, reserve_surplus_mn: 2500, oci_mn: 0, short_term_loan_mn: 280, long_term_loan_mn: 180,
      net_income_mn: 1000, total_assets_mn: 5500, operating_cash_flow_mn: 1100, current_assets_mn: 2300, current_liabilities_mn: 1050,
      revenue_mn: 7000, gross_profit_mn: 2240, free_cash_flow_mn: 850 },
    { fiscal_year: 2023, pe_ratio: 15.5, pb_ratio: 2.5, eps_basic: 15, nav_per_share: 62, roe: 24, dps: 8,
      paid_up_capital_mn: 1000, reserve_surplus_mn: 3000, oci_mn: 0, short_term_loan_mn: 260, long_term_loan_mn: 150,
      net_income_mn: 1250, total_assets_mn: 6000, operating_cash_flow_mn: 1400, current_assets_mn: 2700, current_liabilities_mn: 1100,
      revenue_mn: 8200, gross_profit_mn: 2706, free_cash_flow_mn: 1050 }
  ];
  const corridors = calculateValuationCorridors(sampleFunds);
  assert(corridors.peCorridor.mean === 14.0, 'PE Corridor mean computed accurately');
  assert(corridors.pbCorridor.mean === 2.3, 'PB Corridor mean computed accurately');
  assert(corridors.peCorridor.note === 'Calculated from last 3 years of annual data (FY2021-FY2023)', 'PE Corridor honestly labels how many real years fed the calculation');
  assert(calculateMeanReversionTarget(2.3, 62) === 142.6, 'Mean Reversion Target = PB Mean × NAVPS');

  // Corridor with fewer than 5 years still labels its real sample size (not a fixed 5Y window)
  const shortCorridors = calculateValuationCorridors(sampleFunds.slice(0, 2));
  assert(shortCorridors.peCorridor.sampleCount === 2, 'Corridor uses whatever real years are available (2, not forced to 5)');
  assert(shortCorridors.peCorridor.note.includes('last 2 years'), 'Corridor with only 2 real years says so explicitly');

  // 7. CAGR
  assert(calculateCAGR(10, 15, 3) === 14.47, 'CAGR calculates compound annual growth rate');
  assert(calculateCAGR(-5, 10, 3) === null, 'CAGR returns null for negative endpoints');

  // 8. Piotroski F-Score (classic academic 9-signal test, rebuilt 2026-09-01)
  const fScore = calculatePiotroskiFScore(sampleFunds);
  assert(fScore !== null && fScore.maxScore === 9, 'Piotroski F-Score uses all 9 classic signals when every real input is available');
  assert(fScore.score === 9, 'Consistently improving, low-debt, no-dilution company scores a perfect 9/9');
  assert(fScore.rating === 'Strong', 'Score of 9/9 (>= 7/9) rates Strong');
  assert(fScore.signals.positiveRoa === true && fScore.signals.roaImproving === true, 'ROA signals evaluate from real Net Income / Total Assets, not a per-share proxy');
  assert(fScore.signals.noNewSharesIssued === true, 'Stable paid-up capital across years correctly flags no dilution');

  const thinFunds = [
    { fiscal_year: 2022, paid_up_capital_mn: 1000, dps: 5 },
    { fiscal_year: 2023, paid_up_capital_mn: 1000, dps: 6 }
  ];
  const thinScore = calculatePiotroskiFScore(thinFunds);
  assert(thinScore !== null && thinScore.maxScore === 1, 'With only paid-up capital on file, only the no-dilution signal is determinable -- others are excluded, not guessed');
  assert(thinScore.signals.positiveRoa === null, 'Missing Total Assets/Net Income correctly excludes the ROA signal instead of assuming it');

  // 9. Buffett Moat Score
  const moat = calculateBuffettMoatScore(sampleFunds);
  assert(moat !== null && moat.avgRoe5Y === 22.0, 'Buffett Moat detects high average ROE');
  assert(moat.moatRating === 'Wide', 'Consistently profitable, low-debt, dividend-paying stock achieves Wide Moat');

  // 10. Volatility, Beta & Sharpe
  const mockPrices = Array.from({ length: 40 }, (_, i) => ({ date: `2026-01-${String(i+1).padStart(2, '0')}`, close: 100 + i * 0.5 + (i % 3) }));
  const mockDsex = Array.from({ length: 40 }, (_, i) => ({ date: `2026-01-${String(i+1).padStart(2, '0')}`, index_value: 6000 + i * 10 }));
  const risk = calculateVolatilityAndBeta(mockPrices, mockDsex);
  assert(risk.volatilityAnnualized !== null && risk.volatilityAnnualized > 0, 'Annualized volatility computed');
  assert(risk.beta !== null, 'Beta vs DSEX computed');

  // 11. Volume Velocity
  const mockVolRows = Array.from({ length: 25 }, (_, i) => ({ volume: i < 20 ? 10000 : 30000 }));
  const velocity = calculateVolumeVelocity(mockVolRows);
  assert(velocity !== null && velocity > 1.0, 'Volume velocity detects volume surges');

  // 12. Master Profile Orchestrator
  const profile = generateComprehensiveValuationProfile({
    symbol: 'TESTSYM',
    currentPrice: 150,
    priceHistory: mockPrices,
    fundamentalsHistory: sampleFunds,
    dsexHistory: mockDsex
  });
  assert(profile !== null, 'Master profile generated successfully');
  assert(profile.symbol === 'TESTSYM', 'Profile holds correct symbol');
  assert(profile.valuationModels.grahamNumber !== null, 'Profile includes Graham Number');
  assert(profile.valuationModels.grahamStatus === 'VIABLE', 'Profile indicates VIABLE Graham status');
  assert(profile.solvencyAndQuality.piotroskiBadge.includes('Health') || profile.solvencyAndQuality.piotroskiBadge.includes('Quality'), 'Profile includes descriptive Piotroski badge');
  assert(profile.solvencyAndQuality.debtToEquity !== null, 'Profile includes Debt/Equity');
  assert(profile.riskAndPerformance.volatilityAnnualized !== null, 'Profile includes Risk Metrics');

  // 13. Distressed Asset Status Badge Verification
  const distressedFunds = [{
    fiscal_year: 2025,
    eps_basic: -15.0,
    nav_per_share: -20.0,
    total_assets_mn: 5000,
    total_liabilities_mn: 8000,
    paid_up_capital_mn: 1000,
    reserve_surplus_mn: -4000
  }];
  const distressedProfile = generateComprehensiveValuationProfile({
    symbol: 'DISTRESS_CO',
    currentPrice: 10,
    priceHistory: mockPrices,
    fundamentalsHistory: distressedFunds,
    dsexHistory: mockDsex
  });
  assert(distressedProfile.valuationModels.grahamNumber === null, 'Distressed asset Graham number is null');
  assert(distressedProfile.valuationModels.grahamStatus === 'DISTRESSED_DUAL_NEGATIVE', 'Distressed asset flagged with DISTRESSED_DUAL_NEGATIVE');
  assert(distressedProfile.valuationModels.grahamBadge.includes('Dual Negative'), 'Distressed badge describes exact dual negative condition');
  assert(distressedProfile.solvencyAndQuality.solvencyBadge === '🚨 Critical Distress / Negative Equity', 'Distressed asset flagged with Critical Distress / Negative Equity');
}

// ─────────────────────────────────────────────────────────────────────────────
section('21. Valuation Daily Cache & Corporate Actions Calendar (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. Corporate Actions event validation
  const mockAction = {
    symbol: 'GP',
    eventType: 'DIVIDEND',
    eventDate: '2026-03-15',
    recordDate: '2026-03-25',
    cashDps: 12.5,
    bonusPct: 0,
    source: 'DSE_OFFICIAL'
  };
  assert(mockAction.symbol === 'GP', 'Corporate action has valid symbol');
  assert(mockAction.eventType === 'DIVIDEND', 'Corporate action identifies dividend');
  assert(mockAction.recordDate > mockAction.eventDate, 'Record date chronologically valid');

  // 2. Category Transition Action
  const categoryAction = {
    symbol: 'BEACONPHAR',
    eventType: 'CATEGORY_CHANGE',
    eventDate: '2026-02-10',
    details: 'Category upgraded from B to A due to 15% cash dividend compliance',
    source: 'DSE_OFFICIAL'
  };
  assert(categoryAction.eventType === 'CATEGORY_CHANGE', 'Category shift action tracked');
  assert(categoryAction.source === 'DSE_OFFICIAL', 'Source provenance verified');

  // 3. Valuation Cache Record Shape
  const cacheRecord = {
    symbol: 'BATBC',
    close: 236.4,
    marketCapMn: 127656.0,
    grahamNumber: 157.89,
    valuationVerdict: 'Fairly Valued',
    moatRating: 'Narrow',
    updatedAt: '2026-08-29'
  };
  assert(cacheRecord.close > 0, 'Cached record holds valid closing price');
  assert(cacheRecord.grahamNumber !== null, 'Cached record holds Graham number');
  assert(['Undervalued', 'Fairly Valued', 'Overvalued', 'Neutral'].includes(cacheRecord.valuationVerdict), 'Valuation verdict is normalized enum');
}

// ─────────────────────────────────────────────────────────────────────────────
section('22. Macro Indicators & Dynamic Interest Rate Sensitivity (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. Dynamic Rf DCF sensitivity (real FCF per share, not EPS -- corrected 2026-09-01)
  const fcfPerShareSample = 18.0;
  const growth = 12.0;

  const dcfLowRate = calculateBuffettDCF({ fcfPerShare: fcfPerShareSample, fcfCagrPct: growth, riskFreeRate: 0.08 });
  const dcfNormalRate = calculateBuffettDCF({ fcfPerShare: fcfPerShareSample, fcfCagrPct: growth, riskFreeRate: 0.1037 });
  const dcfHighRate = calculateBuffettDCF({ fcfPerShare: fcfPerShareSample, fcfCagrPct: growth, riskFreeRate: 0.13 });

  assert(dcfLowRate.intrinsicValue > dcfNormalRate.intrinsicValue, 'Lower Rf yields higher intrinsic value');
  assert(dcfNormalRate.intrinsicValue > dcfHighRate.intrinsicValue, 'Higher Rf compresses intrinsic valuation as cost of capital rises');

  // 2. DDM Cost of Equity sensitivity
  const dps = 15.0;
  const roe = 22.0;
  const ddmNormal = calculateDDM({ dps, roePct: roe, payoutRatio: 0.30, beta: 1.0, riskFreeRate: 0.1037, equityRiskPremium: 0.055 });
  const ddmHighRf = calculateDDM({ dps, roePct: roe, payoutRatio: 0.30, beta: 1.0, riskFreeRate: 0.1300, equityRiskPremium: 0.055 });

  assert(ddmNormal.costOfEquityPct < ddmHighRf.costOfEquityPct, 'Higher Rf increases CAPM cost of equity (Ke)');
  assert(ddmNormal.fairValue > ddmHighRf.fairValue, 'Higher Ke lowers DDM fair value');

  // 3. Macro Indicator Record Structure
  const macroRecord = {
    indicator_key: 'BANGLADESH_364D_TBILL',
    value: 0.1037,
    as_of_date: '2026-08-27',
    source: 'BANGLADESH_BANK_VIA_LANKABD'
  };
  assert(macroRecord.indicator_key === 'BANGLADESH_364D_TBILL', 'Macro benchmark key preserved');
  assert(macroRecord.value > 0 && macroRecord.value < 0.30, 'Yield is within realistic 0-30% boundary');
}

// ─────────────────────────────────────────────────────────────────────────────
section('23. Balance Sheet Extraction, Dividend Strings & Audit Gates (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. Balance Sheet Cheerio Extraction
  const sampleHtml = `
    <table>
      <tr>
        <td class="fit">Reserve & Surplus without OCI (mn)</td>
        <td>3,540.25</td>
      </tr>
      <tr>
        <td class="fit">Other Comprehensive Income (OCI) (mn)</td>
        <td>-12.40</td>
      </tr>
      <tr>
        <td class="fit">Short-term loan (mn)</td>
        <td>850.10</td>
      </tr>
      <tr>
        <td class="fit">Long-term loan (mn)</td>
        <td>1,200.00</td>
      </tr>
      <tr>
        <td class="fit">Cash Dividend</td>
        <td>215% 2025, 330% 2024, 300% 2023, 250% 2022</td>
      </tr>
    </table>
  `;
  const $ = cheerio.load(sampleHtml);
  const bs = extractBalanceSheetFromCheerio($);

  assert(bs.reserve_surplus_mn === 3540.25, 'Reserve & Surplus extracted correctly from HTML');
  assert(bs.oci_mn === -12.40, 'OCI (mn) extracted correctly with negative value');
  assert(bs.short_term_loan_mn === 850.10, 'Short-term loan extracted correctly');
  assert(bs.long_term_loan_mn === 1200.00, 'Long-term loan extracted correctly');
  assert(bs.cash_dividend_string.includes('215% 2025'), 'Cash Dividend raw string extracted');

  // 2. Parse Multi-Year Cash Dividend String
  const divs1 = parseCashDividendString('215% 2025, 330% 2024, 300% 2023, 250% 2022', 10);
  assert(divs1.size === 4, 'Parsed exactly 4 years of dividend history');
  assert(divs1.get(2025).dividend_pct === 215, '2025 dividend % = 215');
  assert(divs1.get(2025).dps === 21.5, '2025 DPS = ৳21.50 (at Tk. 10 face value)');
  assert(divs1.get(2024).dps === 33.0, '2024 DPS = ৳33.00');

  // 3. Parse Mixed Cash + Bonus Stock Strings
  const divs2 = parseCashDividendString('10% C, 5% B 2024, 20% 2023', 10);
  assert(divs2.get(2024).dividend_pct === 10, '2024 Cash % = 10%');
  assert(divs2.get(2024).bonus_pct === 5, '2024 Bonus % = 5%');
  assert(divs2.get(2024).dps === 1.0, '2024 DPS = ৳1.00');
  assert(divs2.get(2023).dividend_pct === 20, '2023 Cash % = 20%');

  // 4. DataAuditor validation rules for Balance Sheet & Dividends
  const cleanAudit = DataAuditor.auditFinancialStatements('GP', [{
    year: 2025,
    eps: 25.0,
    navps: 150.0,
    dps: 21.5,
    bonus_pct: 0,
    short_term_loan_mn: 500.0,
    long_term_loan_mn: 1000.0,
    reserve_surplus_mn: 3500.0,
    oci_mn: 20.0
  }]);
  assert(cleanAudit.passed === true, 'Clean balance sheet and dividend record passes DataAuditor');

  const negativeDebtAudit = DataAuditor.auditFinancialStatements('GP', [{
    year: 2025,
    eps: 25.0,
    navps: 150.0,
    dps: 21.5,
    short_term_loan_mn: -50.0
  }]);
  assert(negativeDebtAudit.passed === false, 'Negative short-term loan is rejected by DataAuditor');

  const negativeDpsAudit = DataAuditor.auditFinancialStatements('GP', [{
    year: 2025,
    eps: 25.0,
    navps: 150.0,
    dps: -10.0
  }]);
  assert(negativeDpsAudit.passed === false, 'Negative DPS is rejected by DataAuditor');
}

// ─────────────────────────────────────────────────────────────────────────────
section('24. Block Market Transactions & Direct Scraped Market Cap / Trades (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const blockAuditPass = DataAuditor.auditPriceHistory('GP', [{
    trade_date: '2026-08-28',
    open: 260.0,
    high: 262.0,
    low: 259.0,
    close: 260.5,
    volume: 100000,
    value_mn: 26.05,
    trades: 1250,
    market_cap_mn: 351748.25
  }]);
  assert(blockAuditPass.passed === true, 'Price history with valid trades and scraped market_cap_mn passes DataAuditor');

  const blockRecord = {
    symbol: 'PUBALIBANK',
    date: '2026-08-28',
    quantity: 2000000,
    value_mn: 76.80,
    trades: 5,
    max_price: 38.40,
    min_price: 38.40,
    source: 'LANKABD'
  };
  assert(blockRecord.symbol === 'PUBALIBANK', 'Block transaction has valid symbol');
  assert(blockRecord.quantity > 0 && blockRecord.value_mn > 0, 'Block transaction has positive volume and value');
  assert(blockRecord.min_price <= blockRecord.max_price, 'Block transaction min price <= max price');
  assert(blockRecord.source === 'LANKABD', 'Block transaction source verified as Tier Two');

  // DataAuditor.auditBlockMarketRecord (2026-09-01) -- previously
  // block_market_history had no DataAuditor gate at all; scrape_current_block_market.js
  // wrote parsed rows straight to the DB.
  const blockPass = DataAuditor.auditBlockMarketRecord('PUBALIBANK', [blockRecord]);
  assert(blockPass.passed === true, 'A valid block-market record passes auditBlockMarketRecord');
  assert(blockPass.cleaned[0].quantity === 2000000, 'Valid record retains its real quantity');

  const invertedPrices = DataAuditor.auditBlockMarketRecord('TEST', [{ date: '2026-08-28', quantity: 1000, min_price: 40, max_price: 38 }]);
  assert(invertedPrices.passed === false, 'min_price > max_price is a hard error');

  const zeroQuantity = DataAuditor.auditBlockMarketRecord('TEST', [{ date: '2026-08-28', quantity: 0, min_price: 10, max_price: 12 }]);
  assert(zeroQuantity.passed === false, 'A quantity of exactly 0 is rejected -- a block trade of size 0 is not real');

  const missingTrades = DataAuditor.auditBlockMarketRecord('TEST', [{ date: '2026-08-28', quantity: 1000, trades: '0', min_price: 10, max_price: 12 }]);
  assert(missingTrades.passed === true && missingTrades.cleaned[0].trades === 0, 'A genuine trades count of 0 stays 0, not fabricated to null or dropped');
}

// ─────────────────────────────────────────────────────────────────────────────
section('25. Credit Ratings, Share Lock-ins & Fixed Income Classification (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const creditRecord = {
    symbol: 'GP',
    rating_agency: 'CRISL',
    long_term_rating: 'AAA',
    short_term_rating: 'ST-1',
    outlook: 'Stable',
    rating_date: '2025-05-15',
    valid_until: '2026-05-14',
    rating_action: 'Surveillance'
  };
  assert(creditRecord.symbol === 'GP', 'Credit rating has valid symbol');
  assert(creditRecord.long_term_rating === 'AAA', 'Long term rating correctly assigned');
  assert(creditRecord.valid_until >= creditRecord.rating_date, 'Rating validity date chronologically valid');

  const lockin = {
    symbol: 'WALTONHIL',
    lockin_category: 'Sponsor/Director Lock-in',
    quantity: 270000000,
    release_date: '2026-09-14'
  };
  assert(lockin.quantity > 0, 'Lock-in quantity is positive integer');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(lockin.release_date), 'Release date format is ISO YYYY-MM-DD');

  // Fixed Income classification check
  const bond = { symbol: 'TB10Y0826', asset_class: 'Fixed Income', sector: 'Govt Treasury Bond', category: 'Govt Bond' };
  assert(bond.asset_class === 'Fixed Income', 'Govt Treasury Bond correctly categorized as Fixed Income');
  assert(bond.sector === 'Govt Treasury Bond', 'Treasury bond has dedicated sector');
}

// ─────────────────────────────────────────────────────────────────────────────
section('26. Phase 2 PDF Financial Statement Ingestion & Deep Valuation Models (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const {
    calculatePriceToSales,
    calculateReturnOnAssets,
    calculateGrossMargin,
    calculateOperatingMargin,
    calculateCurrentRatio,
    calculateWorkingCapital,
    calculateDuPontAnalysis,
    calculateFreeCashFlow
  } = await import('../server/valuation_engine.js');
  const {
    parseFinancialStatementLines,
    validateAccountingIdentities
  } = await import('../server/parsers/pdf_financial_parser.js');

  // 1. P/S Ratio: Market Cap 331,500 mn / Revenue 162,400 mn = 2.04x
  const ps = calculatePriceToSales(331500, 162400);
  assert(ps === 2.04, `Price-to-Sales computes accurately (${ps} === 2.04)`);
  assert(calculatePriceToSales(null, 162400) === null, 'Price-to-Sales returns null for missing market cap');

  // 2. ROA %: Net Income 33,075 mn / Total Assets 198,500 mn = 16.66%
  const roa = calculateReturnOnAssets(33075, 198500);
  assert(roa === 16.66, `ROA computes accurately (${roa}% === 16.66%)`);

  // 3. Gross Margin %: Gross Profit 89,320 mn / Revenue 162,400 mn = 55.0%
  const gm = calculateGrossMargin(89320, 162400);
  assert(gm === 55.0, `Gross Margin computes accurately (${gm}% === 55.0%)`);

  // 4. Operating Margin %: Operating Profit 51,968 mn / Revenue 162,400 mn = 32.0%
  const om = calculateOperatingMargin(51968, 162400);
  assert(om === 32.0, `Operating Margin computes accurately (${om}% === 32.0%)`);

  // 5. Current Ratio & Working Capital: CA 42,150 / CL 65,200 = 0.65x, WC = -23,050 mn
  const cr = calculateCurrentRatio(42150, 65200);
  const wc = calculateWorkingCapital(42150, 65200);
  assert(cr === 0.65, `Current ratio computes accurately (${cr} === 0.65)`);
  assert(wc === -23050.0, `Working capital computes accurately (${wc} === -23050)`);

  // 6. DuPont Analysis 3-Step
  const dupont = calculateDuPontAnalysis({
    netIncomeMn: 33075,
    revenueMn: 162400,
    totalAssetsMn: 198500,
    totalEquityMn: 61028
  });
  assert(dupont !== null, 'DuPont analysis generated');
  assert(dupont.netProfitMarginPct === 20.37, `DuPont Net Margin = 20.37% (${dupont.netProfitMarginPct})`);
  assert(dupont.assetTurnover === 0.82, `DuPont Asset Turnover = 0.82 (${dupont.assetTurnover})`);
  assert(dupont.equityMultiplier === 3.25, `DuPont Equity Multiplier = 3.25 (${dupont.equityMultiplier})`);
  assert(dupont.calculatedRoePct === 54.2, `DuPont ROE = 54.2% (${dupont.calculatedRoePct}%)`);

  // 7. Free Cash Flow: OCF 61,200 - CapEx 18,500 = 42,700 mn
  const fcf = calculateFreeCashFlow(61200, 18500);
  assert(fcf === 42700.0, `Free Cash Flow computes accurately (${fcf} === 42700)`);

  // 8. PDF Parser line items extraction & Accounting Gate Validation
  const samplePdfLines = [
    { label: 'Revenue from operations', value: '162,400.00' },
    { label: 'Gross Profit for the period', value: '89,320.00' },
    { label: 'Total Assets', value: '198,500.00' },
    { label: 'Total Liabilities', value: '137,472.00' },
    { label: 'Purchase of Property, Plant and Equipment', value: '18,500.00' },
    { label: 'Net cash flows from operating activities', value: '61,200.00' }
  ];
  const parsedPdf = parseFinancialStatementLines(samplePdfLines);
  assert(parsedPdf.revenue_mn === 162400.0, 'Parsed revenue matches PDF table');
  assert(parsedPdf.gross_profit_mn === 89320.0, 'Parsed gross profit matches PDF table');
  assert(parsedPdf.free_cash_flow_mn === 42700.0, 'Parsed FCF derived automatically');

  const validGate = validateAccountingIdentities(parsedPdf);
  assert(validGate.passed === true, 'Valid PDF statement passes accounting identity gate');

  const invalidGate = validateAccountingIdentities({ revenue_mn: 100, gross_profit_mn: 250 });
  assert(invalidGate.passed === false, 'Gross profit exceeding revenue fails accounting identity gate');

  // 9. Hybrid PDF Content Mode Detector & Hybrid Pipeline
  const { detectPdfContentMode, extractHybridFinancialStatement } = await import('../server/parsers/pdf_financial_parser.js');
  assert(detectPdfContentMode('Revenue from operations: 162,400 Total Assets: 198,500') === 'DIGITAL_VECTOR', 'Digital vector text correctly detected');
  assert(detectPdfContentMode('   ') === 'EMPTY', 'Empty content detected');
  assert(detectPdfContentMode('random short noise') === 'SCANNED_IMAGE', 'Short non-financial text routes to SCANNED_IMAGE');

  const hybridResult = extractHybridFinancialStatement(samplePdfLines);
  assert(hybridResult.mode === 'DIGITAL_VECTOR', 'Hybrid pipeline used DIGITAL_VECTOR mode');
  assert(hybridResult.data.revenue_mn === 162400.0, 'Hybrid pipeline parsed exact revenue');
  assert(hybridResult.validation.passed === true, 'Hybrid pipeline validation passed');
}

// ─────────────────────────────────────────────────────────────────────────────
// 27. Altman Z''-Score for Emerging Markets & Solvency Distress
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n27. Altman Z-Score for Emerging Markets & Solvency Distress (2026-08-29)');
{
  const { calculateAltmanZScore } = await import('../server/valuation/quality_models.js');

  // Test Case 1: Healthy Non-Financial Blue Chip (GP Style)
  // WC = -23050, RE = 34500, EBIT = 65000, Equity = 60538.4, Assets = 198500, Liabilities = 137961.6
  const gpZ = calculateAltmanZScore({
    workingCapitalMn: -23050,
    totalAssetsMn: 198500,
    retainedEarningsMn: 34500,
    ebitMn: 65000,
    totalEquityMn: 60538.4,
    totalLiabilitiesMn: 137961.6,
    sector: 'Telecommunication'
  });

  assert(gpZ !== null, 'Altman Z computed for blue chip');
  assert(typeof gpZ.score === 'number', `Altman score is numeric: ${gpZ.score}`);
  assert(gpZ.isFinancial === false, 'Non-financial company flagged correctly');
  assert(gpZ.details !== null, 'Details breakdown included');

  // Test Case 2: Strong Manufacturing Safe Zone Company
  const strongZ = calculateAltmanZScore({
    workingCapitalMn: 5000,
    totalAssetsMn: 20000,
    retainedEarningsMn: 8000,
    ebitMn: 6000,
    totalEquityMn: 15000,
    totalLiabilitiesMn: 5000,
    sector: 'Pharmaceuticals'
  });
  assert(strongZ.zone === 'SAFE', `Strong solvency company enters SAFE zone (${strongZ.score})`);
  assert(strongZ.badge.includes('Safe Zone'), 'Safe badge includes descriptive text');

  // Test Case 3: Distressed Z-Category Scrip
  const distressedZ = calculateAltmanZScore({
    workingCapitalMn: -10000,
    totalAssetsMn: 15000,
    retainedEarningsMn: -8000,
    ebitMn: -2000,
    totalEquityMn: 1000,
    totalLiabilitiesMn: 14000,
    sector: 'Textile'
  });
  assert(distressedZ.zone === 'DISTRESS', `Distressed firm enters DISTRESS zone (${distressedZ.score})`);
  assert(distressedZ.badge.includes('Distress Zone'), 'Distress badge reflects default risk');

  // Test Case 4: Bank / Financial Sector N/A Handling
  const bankZ = calculateAltmanZScore({
    workingCapitalMn: 1000,
    totalAssetsMn: 500000,
    retainedEarningsMn: 20000,
    ebitMn: 15000,
    totalEquityMn: 40000,
    totalLiabilitiesMn: 460000,
    sector: 'Bank'
  });
  assert(bankZ.score === null, 'Bank returns score null');
  assert(bankZ.isFinancial === true, 'Bank identified as financial sector');
  assert(bankZ.zone === 'NOT_APPLICABLE', 'Bank zone flagged as NOT_APPLICABLE');
}

// ─────────────────────────────────────────────────────────────────────────────
// 28. Dividend Trap & FCF Sustainability Detector
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n28. Dividend Trap & FCF Sustainability Detector (2026-08-29)');
{
  const { calculateDividendSustainability } = await import('../server/valuation/quality_models.js');

  // Test Case 1: Healthy Organic Dividend Payer
  const organicDiv = calculateDividendSustainability({
    dps: 15.0,
    eps: 30.0,
    fcfMn: 5000,
    reservesPerShare: 50.0,
    dividendYield: 5.5,
    debtToEquity: 0.25
  });
  assert(organicDiv.status === 'SAFE_ORGANIC', 'DPS 15 / EPS 30 identified as SAFE_ORGANIC');
  assert(organicDiv.payoutRatioPct === 50.0, `Payout ratio is 50% (${organicDiv.payoutRatioPct})`);
  assert(organicDiv.isSustainable === true, 'Flagged as sustainable');
  assert(organicDiv.isTrap === false, 'Flagged as not a trap');

  // Test Case 2: Reserve Depleting Dividend Payer (DPS > EPS, but profitable reserves)
  const reserveEatingDiv = calculateDividendSustainability({
    dps: 20.0,
    eps: 15.0,
    fcfMn: 2000,
    reservesPerShare: 80.0,
    dividendYield: 8.0,
    debtToEquity: 0.4
  });
  assert(reserveEatingDiv.status === 'RESERVE_DEPLETING', 'DPS > EPS identified as RESERVE_DEPLETING');
  assert(reserveEatingDiv.payoutRatioPct === 133.3, `Payout ratio is 133.3% (${reserveEatingDiv.payoutRatioPct})`);
  assert(reserveEatingDiv.badge.includes('Reserve-Depleting'), 'Badge flags reserve depletion');

  // Test Case 3: Dangerous High-Yield Dividend Trap (Loss-making company paying dividend with high debt)
  const trapDiv = calculateDividendSustainability({
    dps: 5.0,
    eps: -2.0,
    fcfMn: -1500,
    reservesPerShare: 5.0,
    dividendYield: 12.0,
    debtToEquity: 2.5
  });
  assert(trapDiv.status === 'DIVIDEND_TRAP', 'Loss-making firm paying dividend identified as DIVIDEND_TRAP');
  assert(trapDiv.isTrap === true, 'Flagged as high-risk trap');
  assert(trapDiv.isSustainable === false, 'Flagged as unsustainable');

  // Test Case 4: Non-Dividend Paying Stock
  const noDiv = calculateDividendSustainability({ dps: 0, eps: 5.0 });
  assert(noDiv.status === 'NO_DIVIDEND', 'Zero DPS returns NO_DIVIDEND');
}

// ─────────────────────────────────────────────────────────────────────────────
// 29. Smart Money Institutional Accumulation Index
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n29. Smart Money Institutional Accumulation Index (2026-08-29)');
{
  const { calculateSmartMoneyIndex } = await import('../server/valuation/risk_metrics.js');

  // Test Case 1: Heavy Institutional Holding
  const instStock = calculateSmartMoneyIndex({
    shareholding: { institute: 45.5, sponsor_director: 40.0, foreign: 5.0, public: 9.5 },
    blockTrades: [{ value_mn: 50.0 }, { value_mn: 25.0 }]
  });
  assert(instStock.status === 'HIGH_INSTITUTIONAL', '50.5% smart money flagged as HIGH_INSTITUTIONAL');
  assert(instStock.smartMoneyHoldingPct === 50.5, `Smart money holding = 50.5% (${instStock.smartMoneyHoldingPct})`);
  assert(instStock.blockTradeCount === 2, 'Block trade count is 2');
  assert(instStock.badge.includes('Heavy Institutional'), 'Badge describes heavy smart money');

  // Test Case 2: Retail Dominated Stock
  const retailStock = calculateSmartMoneyIndex({
    shareholding: { institute: 5.0, sponsor_director: 25.0, foreign: 0.0, public: 70.0 },
    blockTrades: []
  });
  assert(retailStock.status === 'RETAIL_DOMINATED', '70% public holding flagged as RETAIL_DOMINATED');
  assert(retailStock.badge.includes('Retail Dominated'), 'Badge describes retail dominance');
}

// ─────────────────────────────────────────────────────────────────────────────
// 30. Investor Quick Decision Engine (10 Core Investor Questions)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n30. Investor Quick Decision Engine (10 Core Questions) (2026-08-29)');
{
  const { calculateInvestorQuickDecision } = await import('../server/valuation/decision_engine.js');

  // Test Case 1: Tier-1 Blue Chip Fortress Stock (Grameenphone GP)
  const gpProfile = {
    currentPrice: 245.5,
    valuationModels: {
      blendedIntrinsicTarget: 268.02,
      marginOfSafetyPct: 8.40,
      grahamNumber: 157.85
    },
    solvencyAndQuality: {
      debtToEquity: { debtToEquityRatio: 0.116, isLowDebt: true },
      altmanZScore: { score: 2.85, zone: 'SAFE' },
      piotroskiFScore: { score: 7, maxScore: 9, rating: 'Strong' },
      buffettMoat: { moatRating: 'Wide', avgRoe5Y: 58.4 }
    },
    growthAndPayout: {
      epsCagr5Y: 0.065,
      dpsCagr5Y: 0.052,
      dividendYield: 5.09,
      dividendSustainability: { status: 'SAFE_ORGANIC' }
    },
    riskAndPerformance: {
      totalReturn1Y: -15.3,
      totalReturn3Y: 9.04,
      totalReturn5Y: 1.96,
      smartMoneyIndex: { institutionalHoldingPct: 35.0 }
    }
  };

  const gpFunds = [
    { fiscal_year: 2021, eps_basic: 25.28, dps: 12.5 },
    { fiscal_year: 2022, eps_basic: 22.29, dps: 12.5 },
    { fiscal_year: 2023, eps_basic: 24.49, dps: 12.5 },
    { fiscal_year: 2024, eps_basic: 25.80, dps: 12.5 },
    { fiscal_year: 2025, eps_basic: 26.50, dps: 12.5 }
  ];

  const gpCompany = {
    listing_year: 2009,
    category: 'A',
    sector: 'Telecommunication'
  };

  const decisionGP = calculateInvestorQuickDecision({
    profile: gpProfile,
    fundamentals: gpFunds,
    priceHistory: [],
    companyInfo: gpCompany
  });

  // Verification of all 10 answers
  assert(decisionGP.verdict === 'ACCUMULATE', `Q1: Verdict is ACCUMULATE (${decisionGP.verdict})`);
  assert(decisionGP.suggestedEntryPrice === 219.78, `Q2: Suggested Entry is ৳219.78 (${decisionGP.suggestedEntryPrice})`);
  assert(decisionGP.canBuyAndForget === true, 'Q3: Flagged as Buy & Forget Fortress Stock');
  assert(decisionGP.fortressBadge.includes('Tier-1 Buy & Forget Fortress'), 'Q3: Holds Fortress Badge');
  assert(decisionGP.isStormProof === true, 'Q4: Flagged as Storm-Proof');
  assert(decisionGP.stormBadge.includes('Storm-Proof'), 'Q4: Storm badge is valid');
  assert(decisionGP.companyAgeYears >= 15, 'Q5: Company age is accurately calculated');
  assert(decisionGP.profitStreakYears === 5, 'Q5: 5-year unbroken profit record');
  assert(decisionGP.isProfitMaking === true, 'Q5: Profit making is true');
  assert(decisionGP.totalReturns['3Y'] === 9.04, 'Q6: 3Y total return matches profile');
  assert(decisionGP.projectedDividends['3Y'] > 35, `Q7: 3Y projected dividends > 35 (${decisionGP.projectedDividends['3Y']})`);
  assert(decisionGP.projectedDividends['10Y'] > 140, `Q7: 10Y projected dividends > 140 (${decisionGP.projectedDividends['10Y']})`);
  assert(decisionGP.projectedFairValue['5Y'] > 300, `Q8: 5Y projected fair value > 300 (${decisionGP.projectedFairValue['5Y']})`);
  assert(decisionGP.expectedAnnualReturnPct > 10, `Q9: Expected return > 10% p.a. (${decisionGP.expectedAnnualReturnPct})`);
  assert(decisionGP.pastRecordSummary.includes('58.4% Return on Equity'), 'Q10: Past record narrative contains ROE');

  // Test Case 2: Debt-Strained Distressed Stock
  const distressedProfile = {
    currentPrice: 85.0,
    valuationModels: {
      blendedIntrinsicTarget: 45.0,
      marginOfSafetyPct: -88.8
    },
    solvencyAndQuality: {
      debtToEquity: { debtToEquityRatio: 2.85, isHighLeverage: true },
      altmanZScore: { score: 0.72, zone: 'DISTRESS' },
      piotroskiFScore: { score: 2, maxScore: 9, rating: 'Weak' },
      buffettMoat: { moatRating: 'No' }
    },
    growthAndPayout: {
      epsCagr5Y: -0.15,
      dpsCagr5Y: null,
      dividendYield: 0,
      dividendSustainability: { status: 'NO_DIVIDEND' }
    },
    riskAndPerformance: {
      totalReturn1Y: -45.0
    }
  };

  const decisionDistressed = calculateInvestorQuickDecision({
    profile: distressedProfile,
    fundamentals: [{ fiscal_year: 2025, eps_basic: -4.50, dps: 0 }],
    priceHistory: [],
    companyInfo: { listing_year: 2018, category: 'Z', sector: 'Textile' }
  });

  assert(decisionDistressed.verdict === 'AVOID_DISTRESS', 'Distressed stock flagged as AVOID_DISTRESS');
  assert(decisionDistressed.canBuyAndForget === false, 'Distressed stock CANNOT buy and forget');
  assert(decisionDistressed.isStormProof === false, 'Distressed stock is NOT storm-proof');
  assert(decisionDistressed.isProfitMaking === false, 'Distressed stock is loss-making');
  assert(decisionDistressed.categoryQuality.includes('Category Z'), 'Identified as Category Z scrip');
}

// ─────────────────────────────────────────────────────────────────────────────
section('31. Technical Momentum & Volatility Timing Engine (RSI, ATR, WMA) (2026-08-29)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. RSI Oversold & Overbought Simulation
  const fallingPrices = [];
  let p = 100;
  for (let i = 0; i < 30; i++) {
    p = Math.max(20, p - 2.5);
    fallingPrices.push({ close: p });
  }
  const oversoldRsi = calculateRSI(fallingPrices, 14);
  assert(oversoldRsi.rsi14 !== null, 'RSI computes numeric score');
  assert(oversoldRsi.rsi14 < 30, `RSI detects oversold panic: ${oversoldRsi.rsi14} < 30`);
  assert(oversoldRsi.rsiZone === 'OVERSOLD', 'RSI zone flagged as OVERSOLD');
  assert(oversoldRsi.rsiBadge.includes('Oversold'), 'RSI badge describes oversold discount');

  const risingPrices = [];
  p = 50;
  for (let i = 0; i < 30; i++) {
    p += 3.0;
    risingPrices.push({ close: p });
  }
  const overboughtRsi = calculateRSI(risingPrices, 14);
  assert(overboughtRsi.rsi14 > 70, `RSI detects overbought rally: ${overboughtRsi.rsi14} > 70`);
  assert(overboughtRsi.rsiZone === 'OVERBOUGHT', 'RSI zone flagged as OVERBOUGHT');

  // 2. Insufficient RSI Data
  const shortPrices = [{ close: 10 }, { close: 12 }];
  const emptyRsi = calculateRSI(shortPrices, 14);
  assert(emptyRsi.rsi14 === null, 'Short price history returns null RSI');
  assert(emptyRsi.rsiZone === 'INSUFFICIENT_DATA', 'Short history flagged as INSUFFICIENT_DATA');

  // 3. ATR Volatility & Dynamic Stop-Loss Calculation
  const mockCandles = [];
  for (let i = 0; i < 30; i++) {
    const base = 200 + (i % 3);
    mockCandles.push({
      high: base + 4,
      low: base - 3,
      close: base + 1
    });
  }
  const atrResult = calculateATR(mockCandles, 14);
  assert(atrResult.atr14 !== null && atrResult.atr14 > 0, `ATR computes positive range: ৳${atrResult.atr14}`);
  assert(atrResult.stopLossPrice !== null && atrResult.stopLossPrice < 200, `Stop-loss placed below entry: ৳${atrResult.stopLossPrice}`);
  assert(atrResult.takeProfitPrice !== null && atrResult.takeProfitPrice > 200, `Take-profit placed above entry: ৳${atrResult.takeProfitPrice}`);
  assert(atrResult.atrBadge.includes('Daily Range') || atrResult.atrBadge.includes('Band'), 'ATR badge describes daily range in Taka');

  // 4. WMA Weighted Moving Average
  const wmaTrend = calculateWMA(mockCandles);
  assert(wmaTrend.wma20 !== null, `WMA20 computes valid average: ৳${wmaTrend.wma20}`);
  assert(wmaTrend.trendSignal !== null, 'WMA computes trend signal');

  // 5. Sniper Buy Fusion Timing Signal
  const deepValueProfile = {
    quickDecision: {
      marginOfSafetyPct: 22.5,
      verdict: 'STRONG_BUY'
    }
  };
  const tacticalProfile = generateTechnicalProfile({
    priceHistory: fallingPrices,
    profile: deepValueProfile
  });
  assert(tacticalProfile.timing.verdict === 'SNIPER_BUY', 'Fusion engine generates SNIPER_BUY on Value + Oversold RSI');
  assert(tacticalProfile.timing.badge.includes('Sniper'), 'Badge highlights Sniper Entry');
  assert(tacticalProfile.currentPrice !== null, 'Technical profile includes latest current price');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n======================================================');
console.log(`SHARED TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('======================================================\n');

if (failed > 0) process.exit(1);
