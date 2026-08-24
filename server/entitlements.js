/**
 * Premium entitlement state -- one row per user in `entitlements`,
 * `premium_until` NULL meaning "never purchased." Extended by both the
 * payment flow (server/payments.js, Phase 4) and promo redemption (this
 * file) via the same rule, so there's exactly one definition of "how much
 * time does N days of access actually add." The actual decision logic
 * (the extension-anchor rule, redemption validation) lives in
 * shared/entitlements_logic.js as pure functions -- this file is the thin
 * DB-touching wrapper around them, kept that way specifically so the
 * decisions themselves are unit-testable without a live database
 * (see shared/test_suite.js).
 */
import { dbGet, dbRun } from './db.js';
import { computeExtendedPremiumUntil, isPremiumActive, validatePromoRedemption, totalBonusHours } from '../shared/entitlements_logic.js';

/** { premiumUntil: string|null } -- null means never purchased/redeemed anything. */
export async function getEntitlement(userId) {
  const row = await dbGet(`SELECT premium_until FROM entitlements WHERE user_id = ?`, [userId]);
  return { premiumUntil: row?.premium_until ?? null };
}

export async function isEntitled(userId) {
  if (!userId) return false;
  const { premiumUntil } = await getEntitlement(userId);
  return isPremiumActive(premiumUntil);
}

/**
 * Extends premium_until by `days` using computeExtendedPremiumUntil's
 * anchor rule (see shared/entitlements_logic.js).
 */
export async function extendEntitlement(userId, days) {
  const { premiumUntil } = await getEntitlement(userId);
  const newUntil = computeExtendedPremiumUntil(premiumUntil, days);

  await dbRun(`
    INSERT INTO entitlements (user_id, premium_until, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      premium_until = excluded.premium_until,
      updated_at = excluded.updated_at
  `, [userId, newUntil]);

  return { premiumUntil: newUntil };
}

/**
 * Redeems a promo code for a user. Returns { ok: true, premiumUntil } or
 * { ok: false, reason }. UNIQUE(user_id, code) on promo_redemptions is the
 * real enforcement of "once per user" -- the alreadyRedeemed check below is
 * a fast-path for a clean error message, not the actual safety net (a race
 * between two concurrent redemption attempts is caught by the UNIQUE
 * constraint throwing in the catch block, not by this check).
 */
export async function redeemPromoCode(userId, code) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return { ok: false, reason: 'No code provided' };

  const promo = await dbGet(`SELECT * FROM promo_codes WHERE code = ?`, [cleanCode]);
  const already = await dbGet(
    `SELECT id FROM promo_redemptions WHERE user_id = ? AND code = ?`,
    [userId, cleanCode]
  );

  const decision = validatePromoRedemption({ promo, alreadyRedeemed: !!already });
  if (!decision.ok) return decision;

  try {
    await dbRun(`INSERT INTO promo_redemptions (user_id, code) VALUES (?, ?)`, [userId, cleanCode]);
  } catch (err) {
    // UNIQUE(user_id, code) violation -- a concurrent request won the race.
    return { ok: false, reason: 'You have already redeemed this code' };
  }

  // extendEntitlement/computeExtendedPremiumUntil take fractional days --
  // hours (2026-08-24) convert cleanly to a day fraction rather than needing
  // their own separate extension path.
  const hours = totalBonusHours(promo);
  const { premiumUntil } = await extendEntitlement(userId, hours / 24);
  return { ok: true, premiumUntil, bonusDays: promo.bonus_days, bonusHours: promo.bonus_hours || 0 };
}
