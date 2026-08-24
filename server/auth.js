/**
 * User-facing auth -- Google Sign-In only (see the approved premium-tier
 * plan). Deliberately separate from requireIngestAuth in server/index.js:
 * that's a single static server-to-server key for the pipeline promoter,
 * this is per-user identity with many accounts and varying entitlements.
 * The two must never be conflated.
 */
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { dbGet, dbRun } from './db.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.warn('[AUTH] GOOGLE_CLIENT_ID is not set -- POST /api/auth/google will reject every request until it is.');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const SESSION_COOKIE = 'dse_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Never assume a comma-separated env var is trimmed/cased consistently --
// same defensive normalization this project already applies to symbols
// elsewhere (e.g. `.toUpperCase().trim()` on every incoming symbol).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Verifies a Google ID token server-side (never trust a client-asserted
 * email/name without this) and returns the verified payload, or null if
 * the token is missing/invalid/expired. This is the ONLY place identity
 * gets established -- nothing downstream re-derives "who is this" from
 * anything the client sent directly.
 */
export async function verifyGoogleIdToken(idToken) {
  if (!googleClient || !idToken) return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload?.email) return null;
    return { googleId: payload.sub, email: payload.email, name: payload.name || null };
  } catch (err) {
    console.warn('[AUTH] Google ID token verification failed:', err.message);
    return null;
  }
}

/**
 * Finds the user by google_id, or creates one. Matched on google_id only
 * (not email) -- google_id is the stable, unforgeable identifier Google
 * itself verified; email is descriptive metadata that could theoretically
 * change on Google's side and must never be the join key for identity.
 */
export async function upsertUserFromGoogle({ googleId, email, name }) {
  const existing = await dbGet(`SELECT * FROM users WHERE google_id = ?`, [googleId]);
  if (existing) {
    // Keep email/name fresh (a user's Google display name/email can change)
    // without touching created_at or id.
    if (existing.email !== email || existing.name !== name) {
      await dbRun(`UPDATE users SET email = ?, name = ? WHERE id = ?`, [email, name, existing.id]);
    }
    return { ...existing, email, name };
  }
  const result = await dbRun(
    `INSERT INTO users (google_id, email, name) VALUES (?, ?, ?)`,
    [googleId, email, name]
  );
  return { id: result.lastID, google_id: googleId, email, name };
}

/** Issues a new session row + returns the raw token (the caller sets it as a cookie). */
export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await dbRun(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, userId, expiresAt]);
  return { token, expiresAt };
}

export async function destroySession(token) {
  if (!token) return;
  await dbRun(`DELETE FROM sessions WHERE token = ?`, [token]);
}

/** Returns the user row for a valid, unexpired session token, or null. */
export async function getSessionUser(token) {
  if (!token) return null;
  const session = await dbGet(`SELECT * FROM sessions WHERE token = ?`, [token]);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    // Expired -- clean it up rather than leaving dead rows to accumulate.
    await dbRun(`DELETE FROM sessions WHERE token = ?`, [token]);
    return null;
  }
  return dbGet(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: SESSION_DURATION_MS,
  path: '/',
};

/**
 * Attaches req.user (or null) from the session cookie -- does NOT reject
 * the request either way. Use this on routes that behave differently for
 * logged-in vs. anonymous users but don't strictly require a session
 * (nothing currently needs this shape, but requireUserAuth below is built
 * on it so the "read the cookie" logic exists in exactly one place).
 */
export async function attachUser(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  req.user = token ? await getSessionUser(token) : null;
  next();
}

/** Rejects the request (401) unless a valid session is present. */
export async function requireUserAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Sign-in required' });
  }
  req.user = user;
  next();
}

/**
 * Single source of truth for "is this email an admin" -- used by
 * requireAdminAuth below and by GET /api/auth/me (server/index.js) so the
 * frontend can know to render an Admin entry point at all. Before this,
 * /api/auth/me never exposed admin status, so the header had no way to show
 * an Admin link for anyone -- the /admin/* route worked (backend-gated) but
 * was only reachable by typing the URL directly, even for the configured
 * admin account.
 */
export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

/**
 * Rejects unless the session belongs to an email on ADMIN_EMAILS. Wraps the
 * same session-lookup requireUserAuth uses rather than duplicating it, so
 * there is exactly one code path that decides "is this session valid."
 */
export async function requireAdminAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Sign-in required' });
  }
  if (!isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
}
