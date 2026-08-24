/**
 * Request-layer wiring for the premium gate -- resolves whether the caller
 * is entitled, everything else (what to actually filter/blank) is pure
 * logic in shared/gating_logic.js. Kept separate on purpose: this file
 * touches sessions/cookies/the DB, shared/gating_logic.js doesn't, and only
 * the latter is unit-tested directly.
 */
import { getSessionUser, SESSION_COOKIE_NAME } from './auth.js';
import { isEntitled } from './entitlements.js';
import { freeWindowCutoffDate } from '../shared/plans.js';

/**
 * Attaches req.isEntitled (boolean) and req.freeCutoffDate. Never rejects
 * the request -- gated routes stay reachable for anonymous/free users, they
 * just get the filtered/locked shape. This is deliberately different from
 * requireUserAuth (server/auth.js), which does reject: that's for routes
 * that make no sense at all without a session (promo redemption, the admin
 * panel), this is for routes that serve a real (if smaller) response either way.
 */
export async function attachEntitlement(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const user = token ? await getSessionUser(token) : null;
  req.entitledUser = user;
  req.isEntitled = user ? await isEntitled(user.id) : false;
  req.freeCutoffDate = freeWindowCutoffDate();
  next();
}

/**
 * Hard block for routes with no meaningful "gated preview" -- the 4 bulk
 * CSV export routes. There's no partial/blurred version of a full-archive
 * file download, so unlike attachEntitlement above, this one actually
 * rejects the request (401 signed out, 402 signed in but not entitled)
 * rather than letting it through with a smaller response.
 *
 * This closes a real gap found during the premium-tier planning pass:
 * these 4 routes were public and unauthenticated, serving the complete
 * 13-year archive to anyone who hit the URL directly, which would have
 * made the entire paywall decorative.
 */
export async function requirePremiumAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Sign-in required' });
  }
  const entitled = await isEntitled(user.id);
  if (!entitled) {
    return res.status(402).json({ error: 'An active premium pass is required for full-archive export', unlockUrl: '/plans' });
  }
  req.entitledUser = user;
  next();
}
