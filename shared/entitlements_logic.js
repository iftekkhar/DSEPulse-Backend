/**
 * Pure decision logic for the premium-tier entitlement system -- no DB
 * access, so this is directly unit-testable the same way
 * shared/source_tiers.js's tierAllowsOverwrite or
 * shared/fundamentals_parsing.js's headlineOrContinuing are: pass in
 * inputs, assert on outputs, no live database required. server/entitlements.js
 * is the thin DB-touching wrapper around these -- it fetches rows, calls
 * these, writes the result. Keeping the actual decisions here (not buried
 * in an async DB function) is what makes them testable at all.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The entitlement-extension rule: anchor to whichever is later, the
 * existing premium_until or now, then add `days`. A lapsed/never-purchased
 * user (existingPremiumUntilIso null, or in the past) anchors to now;
 * someone with time remaining stacks the new purchase on top of it rather
 * than wasting the remainder.
 */
export function computeExtendedPremiumUntil(existingPremiumUntilIso, days, nowMs = Date.now()) {
  const existingMs = existingPremiumUntilIso ? new Date(existingPremiumUntilIso).getTime() : null;
  const anchorMs = (existingMs !== null && existingMs > nowMs) ? existingMs : nowMs;
  return new Date(anchorMs + days * DAY_MS).toISOString();
}

/** Is a premium_until value currently active? Null/past = not entitled. */
export function isPremiumActive(premiumUntilIso, nowMs = Date.now()) {
  if (!premiumUntilIso) return false;
  return new Date(premiumUntilIso).getTime() > nowMs;
}

/**
 * Whether a promo redemption attempt should succeed, given the promo row
 * (or null/undefined if the code doesn't exist) and whether this user has
 * already redeemed it. Does not perform the redemption -- just the decision.
 */
export function validatePromoRedemption({ promo, alreadyRedeemed }) {
  if (!promo || !promo.active) {
    return { ok: false, reason: 'Invalid or inactive promo code' };
  }
  if (alreadyRedeemed) {
    return { ok: false, reason: 'You have already redeemed this code' };
  }
  // A code must grant *something* -- bonus_days and bonus_hours (2026-08-24,
  // for flash/hourly promos) are independently optional so an hours-only
  // code ("6 hours, 0 days") is valid, but both being zero/missing means
  // this code was misconfigured, not a real grant.
  const totalHours = totalBonusHours(promo);
  if (totalHours <= 0) {
    return { ok: false, reason: 'This promo code has no bonus time configured' };
  }
  return { ok: true };
}

/** bonus_days + bonus_hours normalized to hours -- the one place this combination happens, so redeemPromoCode and its validation never compute it two different ways. */
export function totalBonusHours(promo) {
  return Number(promo?.bonus_days || 0) * 24 + Number(promo?.bonus_hours || 0);
}
