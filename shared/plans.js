/**
 * Premium tier configuration -- canonical business config, not user data, so
 * it lives here as a documented constant (same pattern as
 * shared/source_tiers.js's SOURCE_TIERS) rather than a DB table. Changing a
 * price or the free-window width is a deliberate, reviewed code change, not
 * something an admin should be able to silently alter at runtime the way
 * promo codes can be (see server/entitlements.js) -- pricing is a business
 * decision that should leave a git history, promo codes are marketing
 * levers meant to be turned on/off quickly.
 */

// Rolling free window: anything within this many days of "today" is free
// forever; the boundary itself moves forward every day. ~6 months.
export const FREE_WINDOW_DAYS = 183;

export const PLANS = {
  WEEKLY:      { days: 7,   priceBdt: 100 },
  MONTHLY:     { days: 30,  priceBdt: 300 },
  QUARTERLY:   { days: 90,  priceBdt: 700 },
  HALF_YEARLY: { days: 180, priceBdt: 1000 },
};

export function isValidPlan(planKey) {
  return Object.prototype.hasOwnProperty.call(PLANS, planKey);
}

// The cutoff date string (YYYY-MM-DD) below which data requires an active
// entitlement. Computed fresh on every call -- never cached -- since the
// whole point of a rolling window is that this boundary moves daily.
export function freeWindowCutoffDate() {
  const d = new Date();
  d.setDate(d.getDate() - FREE_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}
