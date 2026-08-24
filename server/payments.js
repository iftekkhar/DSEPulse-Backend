/**
 * SSLCommerz payment integration -- prepaid time-boxed passes (see
 * shared/plans.js), not auto-recurring subscriptions (SSLCommerz doesn't
 * cleanly support auto-renewal for mobile-money methods like bKash the way
 * card-based Stripe subscriptions do -- see the approved plan).
 *
 * Hard rule enforced throughout this file: entitlement is NEVER extended
 * from the success/fail/cancel redirect alone (a browser-side redirect can
 * be spoofed by anyone who knows the URL shape). Every grant goes through
 * verifyAndGrant(), which independently calls SSLCommerz's own Validation
 * API using the val_id SSLCommerz itself issued, and cross-checks the
 * amount/tran_id against what THIS server recorded as PENDING before
 * extending anything. This mirrors the same "never trust the caller, verify
 * independently" posture the backend already applies to its own data (the
 * DSE live-cross-check tools never trust a scrape without corroboration).
 *
 * NOTE: cannot be exercised end-to-end without real SSLCommerz sandbox
 * credentials (SSLCOMMERZ_STORE_ID/STORE_PASSWORD) -- those require signing
 * up for a sandbox merchant account, which only the account owner can do.
 * Until they're set, initiatePayment() fails closed with a clear reason
 * rather than silently proceeding.
 */
import crypto from 'crypto';
import { PLANS, isValidPlan } from '../shared/plans.js';
import { dbGet, dbRun } from './db.js';
import { extendEntitlement } from './entitlements.js';

const SSLCOMMERZ_STORE_ID = process.env.SSLCOMMERZ_STORE_ID;
const SSLCOMMERZ_STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD;
const SSLCOMMERZ_IS_LIVE = process.env.SSLCOMMERZ_IS_LIVE === 'true';
const SSLCOMMERZ_BASE = SSLCOMMERZ_IS_LIVE
  ? 'https://securepay.sslcommerz.com'
  : 'https://sandbox.sslcommerz.com';

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://localhost:5001';
const FRONTEND_RESULT_URL = process.env.FRONTEND_PAYMENT_RESULT_URL || 'http://localhost:5173/payments/result';

if (!SSLCOMMERZ_STORE_ID || !SSLCOMMERZ_STORE_PASSWORD) {
  console.warn('[PAYMENTS] SSLCOMMERZ_STORE_ID/SSLCOMMERZ_STORE_PASSWORD not set -- POST /api/payments/initiate will fail closed until configured.');
}

// crypto.randomBytes rather than Math.random -- same reasoning as
// server/auth.js's session tokens: a transaction id should be
// collision-resistant and unguessable, which Math.random doesn't
// guarantee, cryptographic randomness does.
function generateTranId(userId) {
  return `dsp_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Creates a PENDING payments row and asks SSLCommerz for a hosted checkout
 * session URL. Returns { ok: true, redirectUrl } or { ok: false, reason }.
 */
export async function initiatePayment(user, planKey) {
  if (!isValidPlan(planKey)) {
    return { ok: false, reason: 'Invalid plan' };
  }
  if (!SSLCOMMERZ_STORE_ID || !SSLCOMMERZ_STORE_PASSWORD) {
    return { ok: false, reason: 'Payment gateway is not configured yet' };
  }

  const plan = PLANS[planKey];
  const tranId = generateTranId(user.id);

  await dbRun(
    `INSERT INTO payments (user_id, gateway, gateway_txn_id, amount_bdt, status, plan) VALUES (?, 'SSLCOMMERZ', ?, ?, 'PENDING', ?)`,
    [user.id, tranId, plan.priceBdt, planKey]
  );

  const params = new URLSearchParams({
    store_id: SSLCOMMERZ_STORE_ID,
    store_passwd: SSLCOMMERZ_STORE_PASSWORD,
    total_amount: String(plan.priceBdt),
    currency: 'BDT',
    tran_id: tranId,
    // success/fail/cancel/ipn can all point at the same route -- the
    // ?status= query param tells the handler which case it is; the actual
    // entitlement grant only ever happens via the shared verifyAndGrant()
    // path regardless of which of these fires (see handlePaymentCallback).
    success_url: `${BACKEND_BASE_URL}/api/payments/callback?status=success`,
    fail_url: `${BACKEND_BASE_URL}/api/payments/callback?status=fail`,
    cancel_url: `${BACKEND_BASE_URL}/api/payments/callback?status=cancel`,
    ipn_url: `${BACKEND_BASE_URL}/api/payments/callback?status=ipn`,
    shipping_method: 'NO',
    product_name: `DSE Pulse Premium (${planKey})`,
    product_category: 'Subscription',
    product_profile: 'general',
    // SSLCommerz requires customer name/address/phone fields even for a
    // digital-only product; Google Sign-In doesn't give us a phone number,
    // so this is a placeholder -- if SSLCommerz's fraud checks ever require
    // a real one, this needs a real "phone" field added to checkout.
    cus_name: user.name || 'DSE Pulse User',
    cus_email: user.email,
    cus_add1: 'Dhaka',
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
    cus_phone: '01700000000',
  });

  try {
    const res = await fetch(`${SSLCOMMERZ_BASE}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
      await dbRun(`UPDATE payments SET status = 'FAILED' WHERE gateway_txn_id = ?`, [tranId]);
      console.warn('[PAYMENTS] SSLCommerz session init did not return SUCCESS:', data.failedreason || data.status);
      return { ok: false, reason: data.failedreason || 'Failed to start checkout session' };
    }
    return { ok: true, redirectUrl: data.GatewayPageURL, tranId };
  } catch (err) {
    await dbRun(`UPDATE payments SET status = 'FAILED' WHERE gateway_txn_id = ?`, [tranId]);
    console.error('[PAYMENTS] initiatePayment error:', err.message);
    return { ok: false, reason: 'Payment gateway unreachable' };
  }
}

/**
 * Independently re-verifies a transaction against SSLCommerz's own
 * Validation API (never trusts amount/status from the redirect/IPN payload
 * itself) and, only if genuinely valid AND the amount matches what this
 * server recorded as PENDING for that plan, extends entitlement. Idempotent:
 * a payment already marked SUCCESS is not re-processed (both success_url and
 * ipn_url can fire for the same transaction; entitlement must not be granted
 * twice for one real payment).
 */
export async function verifyAndGrant(tranId, valId) {
  if (!tranId) return { ok: false, reason: 'Missing tran_id' };

  const payment = await dbGet(`SELECT * FROM payments WHERE gateway_txn_id = ?`, [tranId]);
  if (!payment) return { ok: false, reason: 'Unknown transaction' };
  if (payment.status === 'SUCCESS') {
    // Already processed (e.g. IPN arrived after success_url already granted
    // it) -- report success without granting a second time.
    return { ok: true, alreadyProcessed: true };
  }
  if (!valId) {
    await dbRun(`UPDATE payments SET status = 'FAILED' WHERE gateway_txn_id = ?`, [tranId]);
    return { ok: false, reason: 'Missing val_id -- cannot independently verify' };
  }

  try {
    const params = new URLSearchParams({
      val_id: valId,
      store_id: SSLCOMMERZ_STORE_ID,
      store_passwd: SSLCOMMERZ_STORE_PASSWORD,
      format: 'json',
    });
    const res = await fetch(`${SSLCOMMERZ_BASE}/validator/api/validationserverAPI.php?${params.toString()}`);
    const data = await res.json();

    const validStatuses = ['VALID', 'VALIDATED'];
    const amountMatches = Math.round(Number(data.amount)) === payment.amount_bdt;
    const tranIdMatches = data.tran_id === tranId;

    if (!validStatuses.includes(data.status) || !amountMatches || !tranIdMatches) {
      await dbRun(`UPDATE payments SET status = 'FAILED' WHERE gateway_txn_id = ?`, [tranId]);
      console.warn(`[PAYMENTS] Validation failed for ${tranId}: status=${data.status} amountMatches=${amountMatches} tranIdMatches=${tranIdMatches}`);
      return { ok: false, reason: 'Transaction could not be independently verified' };
    }

    await dbRun(`UPDATE payments SET status = 'SUCCESS' WHERE gateway_txn_id = ?`, [tranId]);
    const plan = PLANS[payment.plan];
    const { premiumUntil } = await extendEntitlement(payment.user_id, plan.days);
    return { ok: true, premiumUntil };
  } catch (err) {
    console.error('[PAYMENTS] verifyAndGrant error:', err.message);
    return { ok: false, reason: 'Verification request failed' };
  }
}

export { FRONTEND_RESULT_URL };
