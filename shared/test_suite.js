/**
 * Extensive test cases for the shared foundation every scraper and DB-write path
 * now depends on: the canonical null/number rule (safe_number.js), the audit
 * gates (data_auditor.js), the scraper kill-switch (scraper_registry.js), and the
 * highest-risk pure parsing logic used by the fundamentals scrapers
 * (fundamentals_parsing.js's multi-group table resolution, shared by both
 * server/scrapers/audited_eps_scraper.js and pipeline's own scraper). Run via
 * `npm test` from the repo root. See ARCHITECTURE.md for the policy this enforces.
 */
import { numOrNull, positiveNumOrNull, deriveOrNull, sumTerm, roundOrNull } from './safe_number.js';
import { DataAuditor } from './data_auditor.js';
import { SCRAPER_REGISTRY, isScraperEnabled, listScrapers, assertNoConflictingScrapers, setRuntimeOverride, clearRuntimeOverride } from './scraper_registry.js';
import { tierOf, isApprovedSource, tierAllowsOverwrite } from './source_tiers.js';
// Imported from shared/ (2026-08-23), not pipeline/src/scrapers/fundamentals_scraper.js
// -- this suite is meant to run in a backend-only environment too (pipeline/
// is dev-only now, see ARCHITECTURE.md), and importing a pipeline file here
// meant `npm test` couldn't even load without pipeline/ present.
import { lastNumberInGroup, headlineOrContinuing } from './fundamentals_parsing.js';
import { computeExtendedPremiumUntil, isPremiumActive, validatePromoRedemption, totalBonusHours } from './entitlements_logic.js';
import { PLANS, FREE_WINDOW_DAYS, isValidPlan, freeWindowCutoffDate } from './plans.js';
import { buildLockedMeta, filterRowsByDateField, limitToLatestFiscalYear, applyDeepDiveGate } from './gating_logic.js';
import { stripInternalFields } from './response_shaping.js';
import { DEFAULT_APP_SETTINGS, isValidSettingKey, getSetting, setSettingOverride, clearSettingOverride, getAllSettings, getAllSettingsWithStatus } from './app_settings.js';

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
section('11. source_tiers.js -- the approved-source list');
// ─────────────────────────────────────────────────────────────────────────────
assert(tierOf('DSE_SCRAPE') === 1, 'DSE_SCRAPE is Tier 1');
assert(tierOf('LANKABD') === 2, 'LANKABD is Tier 2');
assert(tierOf('KAGGLE') === 3, 'KAGGLE is approved Tier 3');
assert(tierOf('MCAP_WEIGHTED_ESTIMATE') === null, 'MCAP_WEIGHTED_ESTIMATE was removed 2026-08-23 (all 57 rows using it turned out to be Friday/Saturday dates or implausible reverting spikes) -- no longer an approved source');
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
assert(tierAllowsOverwrite('KAGGLE', 'KAGGLE') === true, 'same tier (Tier 3) may overwrite');

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

  // server.closing_prices and pipeline.eod_settlement both fire at 15:30 BST and
  // both write real Tier 1 data -- the tier-priority guard allows a same-tier
  // overwrite through by design, so it can't stop this race. assertNoConflictingScrapers
  // is the actual fix: a hard boot-time check instead of a comment in ARCHITECTURE.md.
  let threw = false;
  try { assertNoConflictingScrapers(); } catch { threw = true; }
  assert(threw === false, 'current registry state (both disabled) boots clean');

  const origA = SCRAPER_REGISTRY['server.closing_prices'].enabled;
  const origB = SCRAPER_REGISTRY['pipeline.eod_settlement'].enabled;
  SCRAPER_REGISTRY['server.closing_prices'].enabled = true;
  SCRAPER_REGISTRY['pipeline.eod_settlement'].enabled = true;
  let conflictThrew = false;
  try { assertNoConflictingScrapers(); } catch { conflictThrew = true; }
  SCRAPER_REGISTRY['server.closing_prices'].enabled = origA;
  SCRAPER_REGISTRY['pipeline.eod_settlement'].enabled = origB;
  assert(conflictThrew === true, 'enabling both same-tier 15:30 BST closing-price jobs together throws at boot -- the exact dual-write race');

  // Runtime override (admin panel, 2026-08-23) -- a live toggle must behave
  // exactly like editing the file would, including the same conflict guard.
  assert(isScraperEnabled('server.live_ticker') === false, 'sanity: known-disabled key reads disabled before any override');
  setRuntimeOverride('server.live_ticker', true);
  assert(isScraperEnabled('server.live_ticker') === true, 'a runtime override flips isScraperEnabled immediately, no restart needed');
  clearRuntimeOverride('server.live_ticker');
  assert(isScraperEnabled('server.live_ticker') === false, 'clearing the override falls back to the file\'s own (disabled) default');

  // The exact scenario the admin route's toggle handler guards against: a
  // live override must not be able to create the conflicting-pair state
  // that a file edit is blocked from creating at boot.
  setRuntimeOverride('server.closing_prices', true);
  setRuntimeOverride('pipeline.eod_settlement', true);
  let liveConflictThrew = false;
  try { assertNoConflictingScrapers(); } catch { liveConflictThrew = true; }
  clearRuntimeOverride('server.closing_prices');
  clearRuntimeOverride('pipeline.eod_settlement');
  assert(liveConflictThrew === true, 'a runtime override reaching the same conflicting pair throws too -- admin toggles get the identical safety guarantee as a file edit');
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

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n======================================================');
console.log(`SHARED TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('======================================================\n');

if (failed > 0) process.exit(1);
