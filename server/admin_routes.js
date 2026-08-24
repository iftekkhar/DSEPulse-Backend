/**
 * Admin panel API -- everything here requires requireAdminAuth (see
 * server/auth.js: session + email on ADMIN_EMAILS). Mounted as a factory
 * (createAdminRouter) rather than importing server/index.js's jobStatusRegistry
 * directly, to avoid a circular import between the two files.
 *
 * Every state-changing action here logs to `admin_actions` -- see the plan's
 * note on why: moving the scraper kill-switch from a git-reviewed file edit
 * to a one-click toggle only stays safe if every toggle is traceable to who
 * did it and when.
 */
import express from 'express';
import { dbAll, dbGet, dbRun } from './db.js';
import { requireAdminAuth } from './auth.js';
import { extendEntitlement } from './entitlements.js';
import {
  SCRAPER_REGISTRY,
  listScrapers,
  isScraperEnabled,
  setRuntimeOverride,
  assertNoConflictingScrapers,
} from '../shared/scraper_registry.js';
import { PLANS } from '../shared/plans.js';
import { DEFAULT_APP_SETTINGS, isValidSettingKey, getAllSettingsWithStatus, setSettingOverride, clearSettingOverride } from '../shared/app_settings.js';

async function logAdminAction(adminUserId, action, detail) {
  await dbRun(
    `INSERT INTO admin_actions (admin_user_id, action, detail_json) VALUES (?, ?, ?)`,
    [adminUserId, action, detail ? JSON.stringify(detail) : null]
  );
}

/** Minimal CSV writer -- these exports are at most a few thousand rows (users, payments), not worth a dependency for. Always quotes; escapes embedded quotes/commas/newlines per RFC 4180. */
function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escape(c.get(row))).join(','));
  return [header, ...lines].join('\r\n');
}

export function createAdminRouter({ jobStatusRegistry, jobTriggers }) {
  const router = express.Router();
  router.use(requireAdminAuth);

  // ---- Users ----------------------------------------------------------
  router.get('/users', async (req, res) => {
    try {
      const rows = await dbAll(`
        SELECT u.id, u.email, u.name, u.created_at, e.premium_until
        FROM users u
        LEFT JOIN entitlements e ON e.user_id = u.id
        ORDER BY u.created_at DESC
        LIMIT 500
      `);
      res.json({ users: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // CSV export of the same list -- registered before /users/:id/... routes
  // aren't affected since Express matches this literal path first regardless
  // of order here, but kept next to the JSON list route for readability.
  router.get('/users/export.csv', async (req, res) => {
    try {
      const rows = await dbAll(`
        SELECT u.id, u.email, u.name, u.created_at, e.premium_until
        FROM users u
        LEFT JOIN entitlements e ON e.user_id = u.id
        ORDER BY u.created_at DESC
      `);
      const csv = toCsv(rows, [
        { label: 'ID', get: (r) => r.id },
        { label: 'Email', get: (r) => r.email },
        { label: 'Name', get: (r) => r.name },
        { label: 'Joined', get: (r) => r.created_at },
        { label: 'Premium Until', get: (r) => r.premium_until },
      ]);
      await logAdminAction(req.user.id, 'EXPORT_USERS_CSV', { count: rows.length });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="dsepulse-users-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: 'Failed to export users' });
    }
  });

  // A user's own payment history -- support/dispute lookups ("did my payment
  // actually go through?") without needing direct DB access.
  router.get('/users/:id/payments', async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT id, gateway, gateway_txn_id, amount_bdt, status, plan, created_at
         FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
        [Number(req.params.id)]
      );
      res.json({ payments: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load payment history' });
    }
  });

  // Manual grant/revoke -- support cases (payment succeeded but callback
  // failed, goodwill extension, etc.). days can be negative to effectively
  // revoke (sets premium_until to now, per extendEntitlement's anchor rule
  // this won't go backwards from an already-later date on its own -- a true
  // revoke should pass a large-enough negative or the route below handles
  // "revoke" explicitly by zeroing it out).
  router.post('/users/:id/entitlement', async (req, res) => {
    const userId = Number(req.params.id);
    const { action, days } = req.body; // action: 'grant' | 'revoke'
    try {
      const user = await dbGet(`SELECT id FROM users WHERE id = ?`, [userId]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (action === 'revoke') {
        await dbRun(
          `INSERT INTO entitlements (user_id, premium_until, updated_at) VALUES (?, NULL, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET premium_until = NULL, updated_at = datetime('now')`,
          [userId]
        );
        await logAdminAction(req.user.id, 'REVOKE_ENTITLEMENT', { userId });
        return res.json({ status: 'success', premiumUntil: null });
      }

      const grantDays = Number(days);
      if (!grantDays || grantDays <= 0) {
        return res.status(400).json({ error: 'days must be a positive number for a grant' });
      }
      const { premiumUntil } = await extendEntitlement(userId, grantDays);
      await logAdminAction(req.user.id, 'GRANT_ENTITLEMENT', { userId, days: grantDays });
      res.json({ status: 'success', premiumUntil });
    } catch (err) {
      console.error('[ADMIN] entitlement action error:', err.message);
      res.status(500).json({ error: 'Failed to update entitlement' });
    }
  });

  // ---- Revenue ----------------------------------------------------------
  router.get('/revenue', async (req, res) => {
    try {
      const totals = await dbGet(`
        SELECT COUNT(*) AS successCount, COALESCE(SUM(amount_bdt), 0) AS totalBdt
        FROM payments WHERE status = 'SUCCESS'
      `);
      const byDay = await dbAll(`
        SELECT DATE(created_at) AS day, COUNT(*) AS count, SUM(amount_bdt) AS bdt
        FROM payments WHERE status = 'SUCCESS' AND created_at >= datetime('now', '-90 days')
        GROUP BY DATE(created_at) ORDER BY day ASC
      `);
      const byPlan = await dbAll(`
        SELECT plan, COUNT(*) AS count, SUM(amount_bdt) AS bdt
        FROM payments WHERE status = 'SUCCESS' GROUP BY plan
      `);
      res.json({ totals, byDay, byPlan });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load revenue data' });
    }
  });

  router.get('/payments/export.csv', async (req, res) => {
    try {
      const rows = await dbAll(`
        SELECT p.id, p.user_id, u.email, p.gateway, p.gateway_txn_id, p.amount_bdt, p.status, p.plan, p.created_at
        FROM payments p LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC
      `);
      const csv = toCsv(rows, [
        { label: 'ID', get: (r) => r.id },
        { label: 'User Email', get: (r) => r.email },
        { label: 'Gateway', get: (r) => r.gateway },
        { label: 'Transaction ID', get: (r) => r.gateway_txn_id },
        { label: 'Amount (BDT)', get: (r) => r.amount_bdt },
        { label: 'Status', get: (r) => r.status },
        { label: 'Plan', get: (r) => r.plan },
        { label: 'Created At', get: (r) => r.created_at },
      ]);
      await logAdminAction(req.user.id, 'EXPORT_PAYMENTS_CSV', { count: rows.length });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="dsepulse-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: 'Failed to export payments' });
    }
  });

  // ---- Scrapers & Jobs ----------------------------------------------------------
  router.get('/scrapers', (req, res) => {
    res.json({ scrapers: listScrapers().map(s => ({ ...s, effectiveEnabled: isScraperEnabled(s.key) })) });
  });

  router.post('/scrapers/:key/toggle', async (req, res) => {
    const key = req.params.key;
    const { enabled } = req.body;
    if (!Object.prototype.hasOwnProperty.call(SCRAPER_REGISTRY, key)) {
      return res.status(404).json({ error: 'Unknown scraper key' });
    }

    const previous = isScraperEnabled(key);
    setRuntimeOverride(key, !!enabled);
    try {
      // Re-check the exact safety invariant enforced at boot -- a live
      // toggle must not be able to put two mutually-exclusive scrapers
      // (e.g. server.closing_prices + pipeline.eod_settlement) into a
      // simultaneously-enabled state just because it happens at runtime
      // instead of via a file edit + restart.
      assertNoConflictingScrapers();
    } catch (err) {
      setRuntimeOverride(key, previous); // roll back
      return res.status(409).json({ error: err.message });
    }

    await dbRun(
      `INSERT INTO scraper_settings (scraper_key, enabled, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(scraper_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key, enabled ? 1 : 0, req.user.id]
    );
    await logAdminAction(req.user.id, 'TOGGLE_SCRAPER', { key, enabled: !!enabled, previous });
    res.json({ status: 'success', key, enabled: !!enabled });
  });

  router.get('/jobs/status', (req, res) => {
    res.json({ ...jobStatusRegistry });
  });

  router.post('/jobs/:jobKey/trigger', async (req, res) => {
    const trigger = jobTriggers?.[req.params.jobKey];
    if (!trigger) return res.status(404).json({ error: 'Unknown job' });
    try {
      trigger().catch(e => console.error(`[ADMIN] Job ${req.params.jobKey} error:`, e.message));
      await logAdminAction(req.user.id, 'TRIGGER_JOB', { job: req.params.jobKey });
      res.json({ status: 'success', message: 'Job triggered in background' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to trigger job' });
    }
  });

  // ---- Audit reports ----------------------------------------------------------
  router.get('/audit-reports', async (req, res) => {
    try {
      const rows = await dbAll(`SELECT id, run_at, target_entity, records_audited, errors_count, warnings_count, status FROM audit_reports ORDER BY run_at DESC LIMIT 100`);
      res.json({ reports: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list audit reports' });
    }
  });

  router.get('/audit-reports/:id', async (req, res) => {
    try {
      const row = await dbGet(`SELECT * FROM audit_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json({ report: { ...row, report_json: row.report_json ? JSON.parse(row.report_json) : null } });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load audit report' });
    }
  });

  // ---- Promo codes ----------------------------------------------------------
  router.get('/promo-codes', async (req, res) => {
    try {
      const codes = await dbAll(`SELECT * FROM promo_codes ORDER BY created_at DESC`);
      const redemptions = await dbAll(`SELECT code, COUNT(*) AS count FROM promo_redemptions GROUP BY code`);
      const counts = Object.fromEntries(redemptions.map(r => [r.code, r.count]));
      res.json({ codes: codes.map(c => ({ ...c, redemptionCount: counts[c.code] || 0 })) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list promo codes' });
    }
  });

  router.post('/promo-codes', async (req, res) => {
    const { code, bonusDays, bonusHours, active } = req.body;
    const cleanCode = String(code || '').trim().toUpperCase();
    const days = Number(bonusDays) || 0;
    const hours = Number(bonusHours) || 0;
    // Either can be zero (an hours-only flash promo, or a days-only classic
    // one) as long as their combination is positive -- both zero is the
    // actual misconfiguration, not "days alone must be positive" (that
    // would make an hours-only code impossible to create).
    if (!cleanCode || days < 0 || hours < 0 || (days + hours) <= 0) {
      return res.status(400).json({ error: 'code is required, and bonusDays + bonusHours must combine to a positive amount' });
    }
    try {
      await dbRun(
        `INSERT INTO promo_codes (code, bonus_days, bonus_hours, active, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(code) DO UPDATE SET bonus_days = excluded.bonus_days, bonus_hours = excluded.bonus_hours, active = excluded.active, updated_at = datetime('now')`,
        [cleanCode, days, hours, active === false ? 0 : 1]
      );
      await logAdminAction(req.user.id, 'UPSERT_PROMO_CODE', { code: cleanCode, bonusDays: days, bonusHours: hours, active: active !== false });
      res.json({ status: 'success' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save promo code' });
    }
  });

  // ---- Settings (shared/app_settings.js -- see that file for why PLANS/
  // FREE_WINDOW_DAYS are deliberately not here) --------------------------------
  router.get('/settings', (req, res) => {
    res.json({ settings: getAllSettingsWithStatus(), defaults: DEFAULT_APP_SETTINGS });
  });

  router.post('/settings/:key', async (req, res) => {
    const key = req.params.key;
    if (!isValidSettingKey(key)) {
      return res.status(404).json({ error: 'Unknown setting key' });
    }
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'value is required' });
    }
    try {
      setSettingOverride(key, value);
      await dbRun(
        `INSERT INTO app_settings (setting_key, value_json, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [key, JSON.stringify(value), req.user.id]
      );
      await logAdminAction(req.user.id, 'UPDATE_APP_SETTING', { key, value });
      res.json({ status: 'success', key, value });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save setting' });
    }
  });

  // Clears the override entirely (not "set back to the current default
  // value") so a later change to the file's own default takes effect again
  // automatically, the same as a scraper that's never had its file default
  // overridden at all.
  router.delete('/settings/:key', async (req, res) => {
    const key = req.params.key;
    if (!isValidSettingKey(key)) {
      return res.status(404).json({ error: 'Unknown setting key' });
    }
    try {
      clearSettingOverride(key);
      await dbRun(`DELETE FROM app_settings WHERE setting_key = ?`, [key]);
      await logAdminAction(req.user.id, 'RESET_APP_SETTING', { key });
      res.json({ status: 'success', key, value: DEFAULT_APP_SETTINGS[key] });
    } catch (err) {
      res.status(500).json({ error: 'Failed to reset setting' });
    }
  });

  // ---- System health ----------------------------------------------------------
  router.get('/system-health', async (req, res) => {
    try {
      const tables = ['price_history', 'dsex_market_history', 'fundamentals_history', 'company_list', 'users', 'payments', 'entitlements'];
      const rowCounts = {};
      for (const t of tables) {
        const row = await dbGet(`SELECT COUNT(*) AS c FROM ${t}`);
        rowCounts[t] = row.c;
      }
      res.json({ rowCounts, jobStatus: jobStatusRegistry, plans: PLANS });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load system health' });
    }
  });

  // ---- Admin action log itself ----------------------------------------------------------
  router.get('/actions', async (req, res) => {
    try {
      const rows = await dbAll(`
        SELECT a.id, a.action, a.detail_json, a.created_at, u.email AS adminEmail
        FROM admin_actions a JOIN users u ON u.id = a.admin_user_id
        ORDER BY a.created_at DESC LIMIT 200
      `);
      res.json({ actions: rows.map(r => ({ ...r, detail_json: r.detail_json ? JSON.parse(r.detail_json) : null })) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load admin action log' });
    }
  });

  return router;
}
