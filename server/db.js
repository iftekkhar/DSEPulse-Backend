import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { numOrNull } from '../shared/safe_number.js';
import { tierAllowsOverwrite, tierOf, PROMOTION_OWNED_SOURCES } from '../shared/source_tiers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'dse.db');

let sqlite3 = null;
let db = null;
export let isSqliteAvailable = false;

try {
  const sqliteMod = await import('sqlite3');
  sqlite3 = sqliteMod.default || sqliteMod;
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.warn('[SQLITE] Database file warning, using fallback engine:', err.message);
      isSqliteAvailable = false;
    } else {
      isSqliteAvailable = true;
      console.log('[SQLITE] Connected to SQLite database:', DB_PATH);
    }
  });
  isSqliteAvailable = true;
} catch (e) {
  console.warn('[SQLITE] Native C++ binding unavailable (GLIBC/host). Activating Zero-Fail Master Engine:', e.message);
  isSqliteAvailable = false;
}

// Async DB execution helpers with safe fallback
export function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!isSqliteAvailable || !db) return resolve({ changes: 0, lastID: 0 });
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

export function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!isSqliteAvailable || !db) return resolve([]);
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!isSqliteAvailable || !db) return resolve(null);
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

export function dbPrepare(sql) {
  if (!isSqliteAvailable || !db) {
    return {
      run: () => {},
      finalize: (cb) => { if (cb) cb(); }
    };
  }
  return db.prepare(sql);
}

// High-Performance PRAGMA configuration
export async function applyPragmas() {
  if (!isSqliteAvailable || !db) return;
  try {
    await dbRun(`PRAGMA journal_mode = WAL;`);
    await dbRun(`PRAGMA synchronous = NORMAL;`);
    await dbRun(`PRAGMA cache_size = -64000;`); // ~64MB memory page cache
    await dbRun(`PRAGMA temp_store = MEMORY;`);
    await dbRun(`PRAGMA busy_timeout = 5000;`);
    // SQLite ignores REFERENCES clauses unless this is explicitly on, and it
    // must be set per-connection (not a persistent DB-level setting) -- added
    // 2026-08-23 when the premium-tier tables (sessions/entitlements/payments/
    // promo_redemptions/admin_actions) introduced the first REFERENCES clauses
    // in this schema, which had been silently decorative-only until now. No
    // effect on the pre-existing tables -- none of them declare a REFERENCES
    // clause, so there's nothing new to enforce on data that already exists.
    await dbRun(`PRAGMA foreign_keys = ON;`);
  } catch (e) {
    console.warn('[SQLITE] Pragma notice:', e.message);
  }
}

// Initialize Tables & Covering Indexes
export async function initDB() {
  await applyPragmas();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      ycp REAL,
      change REAL,
      change_percent REAL,
      volume INTEGER,
      value_mn REAL,
      pe REAL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date)
    );
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_symbol_date ON price_history(symbol, date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_date ON price_history(date DESC);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_history_cov ON price_history(symbol, date DESC, close, ycp, change, change_percent, volume, pe);`);
  // Same tier-tracking as dsex_market_history.source above -- price_history is
  // currently 100% Tier 1 (DSE_SCRAPE) / Tier 2 (LANKABD) with no Tier 3 rows, but
  // the column exists uniformly so that guarantee is enforced going forward
  // rather than true by current accident.
  try { await dbRun(`ALTER TABLE price_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dsex_market_history (
      date TEXT PRIMARY KEY,
      dsex_index REAL NOT NULL,
      advancing INTEGER,
      declining INTEGER,
      unchanged INTEGER,
      total_trades INTEGER,
      total_volume INTEGER,
      total_value_mn REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dsex_hist_date ON dsex_market_history(date DESC);`);
  // Tracks which Tier this row's dsex_index came from (see ARCHITECTURE.md's tier
  // list) -- previously staging labeled every row's provenance but that label was
  // dropped on promotion, leaving the main DB unable to distinguish a real
  // DSE-published index value from an approved Tier 3 reconstruction/estimate.
  try { await dbRun(`ALTER TABLE dsex_market_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS fundamentals_history (
      symbol TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      period TEXT,
      eps_basic REAL,
      eps_diluted REAL,
      nav_per_share REAL,
      roe REAL,
      dividend_yield REAL,
      paid_up_capital_mn REAL,
      authorized_capital_mn REAL,
      pe_ratio REAL,
      debt_to_equity REAL,
      current_ratio REAL,
      audit_status TEXT DEFAULT 'Audited',
      recorded_at TEXT,
      PRIMARY KEY (symbol, fiscal_year)
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_fund_hist_sym ON fundamentals_history(symbol, fiscal_year DESC);`);
  // company_fundamentals (dropped 2026-08-23, see ARCHITECTURE.md) tracked a
  // few Job-3-only fields staging's stg_annual_fundamentals never had a column
  // for either -- added here so that real, actually-scraped data doesn't get
  // silently discarded now that fundamentals_history is the only table.
  // name/sector/category are deliberately NOT added here: company_list (below)
  // already owns those, and duplicating them across two tables was the
  // original design smell, not something worth preserving.
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN eps_quarterly REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN pe_diluted REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN pe_trailing REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN quarterly_disclosure TEXT;`); } catch { /* column exists */ }
  // source added 2026-08-23: fundamentals_history never tracked provenance at
  // all before. 'Audited' rows (promoted) get STAGING_DB; 'Provisional' rows
  // (Job 3) get whatever live tag Job 3 itself is tagged with (DSE_OFFICIAL) --
  // see saveFundamentalsBulkDelta and /api/ingest/fundamentals.
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN source TEXT;`); } catch { /* column exists */ }
  // dps (Cash Dividend Per Share, BDT) added 2026-08-24: was already being
  // scraped correctly (fundamentals_scraper.js computes it from
  // dividend_pct * face_value, stored in stg_annual_fundamentals.dps for
  // every fiscal year) but the promoter never carried it into this table --
  // dividend_yield alone can't answer "how many taka per share" without
  // also knowing that year's price, which this table doesn't store either.
  try { await dbRun(`ALTER TABLE fundamentals_history ADD COLUMN dps REAL;`); } catch { /* column exists */ }

  // Mirrors stg_company_list exactly -- promoted from staging (see
  // pruneOrphanedCompanyListRows/saveCompanyList below), 2026-08-23.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS company_list (
      symbol            TEXT PRIMARY KEY,
      name              TEXT,
      sector            TEXT,
      category          TEXT,
      listing_date      TEXT,
      face_value        REAL DEFAULT 10.0,
      total_shares      INTEGER,
      market_cap_mn     REAL,
      is_active         INTEGER DEFAULT 1,
      fetched_at        TEXT NOT NULL,
      source            TEXT
    );
  `);
  try { await dbRun(`ALTER TABLE company_list ADD COLUMN source TEXT;`); } catch { /* column exists */ }

  // Mirrors stg_audit_reports' shape, but this is main DB's OWN independent
  // audit log -- populated only by server/audit/db_auditor.js when the main-DB
  // audit is actually run, never by promotion (staging's audit history and
  // main DB's audit history are different facts about different databases;
  // syncing one into the other would misrepresent which DB was actually
  // checked). Added 2026-08-23.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at            TEXT NOT NULL,
      target_entity     TEXT NOT NULL,
      records_audited   INTEGER NOT NULL,
      errors_count      INTEGER NOT NULL,
      warnings_count    INTEGER NOT NULL,
      status            TEXT NOT NULL,
      report_json       TEXT
    );
  `);

  // ---------------------------------------------------------------
  // Premium tier: auth, entitlements, payments (added 2026-08-23).
  // See ARCHITECTURE.md's premium-tier section (once written) / the
  // approved plan for the full design. Additive only -- nothing above
  // this point changes.
  // ---------------------------------------------------------------

  // Google Sign-In only -- no password_hash column exists on purpose (see
  // the plan: hand-rolled password auth was explicitly dropped in favor of
  // Google-only identity, removing an entire category of risk).
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id   TEXT UNIQUE NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);

  // premium_until NULL = never purchased. A purchase/promo redemption always
  // extends from MAX(existing premium_until, now()), never just sets it to
  // "now() + N days" outright -- see extendEntitlement in server/entitlements.js.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id       INTEGER PRIMARY KEY REFERENCES users(id),
      premium_until TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  // Per-account watchlist (2026-08-24) -- previously localStorage-only (see
  // App.jsx), which meant a signed-in user's watchlist didn't follow them to
  // a second device/browser, or survive clearing site data. Signed-in users
  // now sync here; an anonymous visitor still gets the old localStorage-only
  // behavior (see services/watchlist.js on the frontend) since there's no
  // account to attach rows to. PRIMARY KEY(user_id, symbol) is the real
  // "can't add the same symbol twice" enforcement, not app-level dedup alone.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_watchlist (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      symbol    TEXT NOT NULL,
      added_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, symbol)
    );
  `);

  // gateway_txn_id UNIQUE -- SSLCommerz's own transaction id, so a
  // duplicate/replayed callback can never extend entitlement twice for the
  // same real-world transaction.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      gateway         TEXT NOT NULL,
      gateway_txn_id  TEXT UNIQUE,
      amount_bdt      INTEGER NOT NULL,
      status          TEXT NOT NULL,
      plan            TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);`);

  // Admin-editable (code string + bonus_days + active), not a hardcoded
  // constant -- an admin can change PULSE24's value or add a new code
  // without a code deploy. See server/admin_routes.js (Phase 6).
  await dbRun(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code        TEXT PRIMARY KEY,
      bonus_days  INTEGER NOT NULL,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);
  // bonus_hours (2026-08-24): flash/short-window promos ("6 hours of
  // premium") alongside the existing day-granularity ones -- additive, not
  // a replacement, so PULSE24/etc. (bonus_days-only) are unaffected.
  // Default 0 (not NULL) so `bonus_days + bonus_hours/24` in
  // redeemPromoCode never has to null-guard a pre-existing code.
  try { await dbRun(`ALTER TABLE promo_codes ADD COLUMN bonus_hours INTEGER DEFAULT 0;`); } catch { /* column exists */ }

  // UNIQUE(user_id, code) is the actual enforcement of "each user can
  // redeem a given code once" -- not application-level logic alone, which
  // would race under concurrent requests.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      code         TEXT NOT NULL REFERENCES promo_codes(code),
      redeemed_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, code)
    );
  `);

  // Every sensitive admin-panel action (entitlement grant/revoke, scraper
  // toggle, promo edit) logs here -- see the plan's note on why this
  // matters: moving scraper on/off from a git-reviewed file edit to a
  // one-click admin toggle only stays safe if every toggle is traceable.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id  INTEGER NOT NULL REFERENCES users(id),
      action         TEXT NOT NULL,
      detail_json    TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed the one launch promo code. INSERT OR IGNORE -- only ever seeds
  // once; an admin editing bonus_days/active afterward via the admin panel
  // must never get silently reverted by a later server restart re-running
  // initDB().
  await dbRun(`INSERT OR IGNORE INTO promo_codes (code, bonus_days, active) VALUES ('PULSE24', 1, 1)`);

  // Admin-panel override for shared/scraper_registry.js's `enabled` flags
  // (Phase 6, 2026-08-23). The registry file itself stays the source of
  // truth for what a scraper IS and its documented default -- this table is
  // only consulted (via isScraperRuntimeEnabled in server/admin_routes.js)
  // when a row exists for a given key, overriding the file's default until
  // an admin flips it back. No row here for a key = falls through to the
  // file's own `enabled` value, unchanged from how every scraper worked
  // before the admin panel existed.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS scraper_settings (
      scraper_key  TEXT PRIMARY KEY,
      enabled      INTEGER NOT NULL,
      updated_at   TEXT DEFAULT (datetime('now')),
      updated_by   INTEGER REFERENCES users(id)
    );
  `);

  // Admin-panel override for shared/app_settings.js's runtime-tunable config
  // (freeCompareLimit, the site announcement banner -- 2026-08-24). Same
  // shape/reasoning as scraper_settings above: the shared module's defaults
  // stay the source of truth for what a setting IS and its documented
  // default, this table is only consulted when a row exists for a given
  // key. Deliberately does NOT cover shared/plans.js's PLANS/FREE_WINDOW_DAYS
  // -- see that file's own docstring for why pricing stays a reviewed code
  // change (2026-08-24: reconsidered and confirmed to stay that way).
  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key  TEXT PRIMARY KEY,
      value_json   TEXT NOT NULL,
      updated_at   TEXT DEFAULT (datetime('now')),
      updated_by   INTEGER REFERENCES users(id)
    );
  `);

  // Shareholding pattern (Sponsor/Director, Govt, Institute, Foreign,
  // Public %) -- current-snapshot only, by explicit product decision
  // (2026-08-24): DSE's own company page already publishes the latest
  // disclosed month alongside the one before it on every fetch (see
  // server/scrapers/audited_eps_scraper.js), so this table is overwritten
  // wholesale on every scrape -- one row per symbol, never a growing
  // history. "Previous" here means "the prior disclosed month DSE itself
  // showed on this same page load," not an archive this app maintains.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS shareholding_current (
      symbol          TEXT PRIMARY KEY,
      sponsor_pct     REAL,
      govt_pct        REAL,
      institute_pct   REAL,
      foreign_pct     REAL,
      public_pct      REAL,
      as_of_date      TEXT,
      prev_sponsor_pct   REAL,
      prev_govt_pct      REAL,
      prev_institute_pct REAL,
      prev_foreign_pct   REAL,
      prev_public_pct    REAL,
      prev_as_of_date    TEXT,
      updated_at      TEXT DEFAULT (datetime('now')),
      source          TEXT
    );
  `);

  await dbRun(`DELETE FROM price_history WHERE date LIKE '%T%' OR date LIKE '%:%'`).catch(() => {});
}

// tierAllowsOverwrite (ARCHITECTURE.md item 5) now lives in shared/source_tiers.js
// so server/db.js and pipeline/src/db/staging_db.js share one implementation --
// both have the exact same dual-writer risk (Job 1 / pipeline.eod_settlement here;
// gap_scraper.js / lankabd_scraper.js there).

// 1. High-Speed Bulk Daily Market Closing Batch Ingestion
export async function saveDailyClosingToDB(records, dateStr) {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  if (!isSqliteAvailable || !db) return 0;
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  // Existing sources for this date, fetched once up front -- see
  // tierAllowsOverwrite above for why this matters.
  const existingRows = await dbAll(`SELECT symbol, source FROM price_history WHERE date = ?`, [targetDate]);
  const existingSourceMap = new Map(existingRows.map(r => [r.symbol, r.source]));

  let count = 0;
  let blockedByTier = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, close, ycp, change, change_percent, volume, pe, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        pe = excluded.pe,
        source = COALESCE(excluded.source, price_history.source)
    `);

    for (const r of records) {
      const symbol = (r.symbol || '').toUpperCase().trim();
      // null (not 0) when none of the 3 price aliases are present, so a record
      // with genuinely no price data is skipped for being unusable -- not because
      // a fabricated 0 happened to fail the close <= 0 check below.
      const closeRaw = r.ltp ?? r.close ?? r.closePrice ?? null;
      const close = closeRaw !== null ? Number(closeRaw) : null;
      if (!symbol || close === null || close <= 0) continue;

      // None of these are NOT NULL in the schema -- preserve null for anything
      // genuinely missing rather than writing a fabricated 0 (a real stock's ycp,
      // change, or volume is never actually 0 in the "we don't know" sense).
      const ycp = numOrNull(r.ycp);
      const change = numOrNull(r.change)
        ?? (ycp !== null && ycp > 0 ? Number((close - ycp).toFixed(2)) : null);
      const change_percent = numOrNull(r.changePercent)
        ?? (ycp !== null && ycp > 0 ? Number((((close - ycp) / ycp) * 100).toFixed(2)) : null);
      const volume = numOrNull(r.volume);
      const pe = numOrNull(r.pe);
      // Tier -- see ARCHITECTURE.md. A live scrape (Job 1) tags its own source
      // below before calling this; a promoted staging row carries its real
      // source (DSE_SCRAPE/LANKABD) straight through.
      const source = r.source || null;

      if (!tierAllowsOverwrite(existingSourceMap.get(symbol), source)) {
        blockedByTier++;
        continue;
      }

      stmt.run([symbol, targetDate, close, ycp, change, change_percent, volume, pe, source]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] saveDailyClosingToDB: ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source (see shared/source_tiers.js).`);
  }
  return count;
}

// 1b. Bulk-write one symbol's full multi-date history in a SINGLE transaction.
// saveDailyClosingToDB above is shaped for "many symbols, one shared date" (Job 1's
// use case) and does its own BEGIN/COMMIT per call -- fine for that, but calling it
// once per row to ingest one symbol's multi-year history (as /api/ingest/history
// used to) means one transaction (fsync) per row: thousands of commits for a single
// symbol, slow enough to time out the caller. This does the same upsert, but for
// many (date, record) pairs against one symbol in one transaction.
export async function saveSymbolHistoryBulk(symbol, records) {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  if (!isSqliteAvailable || !db) return 0;
  const cleanSym = (symbol || '').toUpperCase().trim();
  if (!cleanSym) return 0;

  // Existing sources for this symbol, fetched once up front -- see
  // tierAllowsOverwrite in shared/source_tiers.js.
  const existingRows = await dbAll(`SELECT date, source FROM price_history WHERE symbol = ?`, [cleanSym]);
  const existingSourceMap = new Map(existingRows.map(r => [r.date, r.source]));

  let count = 0;
  let blockedByTier = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, pe, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        value_mn = excluded.value_mn,
        pe = excluded.pe,
        source = COALESCE(excluded.source, price_history.source)
    `);

    for (const r of records) {
      const date = r.date;
      // null (not 0) when neither alias is present -- see saveDailyClosingToDB
      // above for why this must skip on missing data rather than fall through a
      // fabricated 0 into the close <= 0 guard.
      const closeRaw = r.close ?? r.ltp ?? null;
      const close = closeRaw !== null ? Number(closeRaw) : null;
      if (!date || close === null || close <= 0) continue;

      const open = numOrNull(r.open);
      const high = numOrNull(r.high);
      const low = numOrNull(r.low);
      const ycp = numOrNull(r.ycp);
      // No derive-from-close-ycp fallback here (unlike saveDailyClosingToDB,
      // which legitimately derives for TODAY's live data that has no staged
      // record to compare against). This function is promotion's only write
      // path -- per policy, price_history must match stg_price_history
      // exactly, cell for cell, so a null here must stay null rather than
      // being silently replaced with a locally-computed value staging never
      // had. Passing r.change/r.changePercent straight through, undefaulted.
      const change = numOrNull(r.change);
      const change_percent = numOrNull(r.changePercent);
      const volume = numOrNull(r.volume);
      const value_mn = numOrNull(r.valueMn);
      const pe = numOrNull(r.pe);
      // Every promoted row is tagged STAGING_DB uniformly now (see
      // shared/source_tiers.js) -- the caller (manual_promoter.js) sets this,
      // not the granular staging-internal tier (DSE_SCRAPE/LANKABD/etc.).
      const source = r.source || null;

      if (!tierAllowsOverwrite(existingSourceMap.get(date), source)) {
        blockedByTier++;
        continue;
      }

      stmt.run([cleanSym, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, pe, source]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  if (blockedByTier > 0) {
    console.warn(`[SQLITE] saveSymbolHistoryBulk(${cleanSym}): ${blockedByTier} record(s) skipped -- existing row already has a better/equal-tier source.`);
  }
  return count;
}

/**
 * Deletes price_history rows for one symbol that staging no longer has, so
 * promotion syncs instead of only ever adding/updating. Same two-way scoping
 * as pruneOrphanedDSEXRows: only DSE_SCRAPE/LANKABD rows (never
 * DSE_LIVE_CLOSING, which Job 1 writes directly), and only dates absent from
 * `validDates` -- the complete current stg_price_history rows for this symbol,
 * which the promoter always sends as one full per-symbol batch.
 */
export async function pruneOrphanedPriceHistoryRows(symbol, validDates) {
  const cleanSym = (symbol || '').toUpperCase().trim();
  if (!cleanSym) return 0;
  // Same safety guard as pruneOrphanedDSEXRows (see its comment) -- an empty
  // incoming set must never wipe this symbol's whole real price history.
  // manual_promoter.js only ever calls this for a symbol it found real
  // stg_price_history rows for, so a legitimate call is never empty.
  if (!validDates || validDates.length === 0) {
    console.warn(`[SQLITE] pruneOrphanedPriceHistoryRows(${cleanSym}): called with an empty valid-dates set -- refusing to prune. No-op.`);
    return 0;
  }
  const ownedSources = PROMOTION_OWNED_SOURCES.price_history;
  const placeholders = ownedSources.map(() => '?').join(',');
  const candidates = await dbAll(`SELECT date FROM price_history WHERE symbol = ? AND source IN (${placeholders})`, [cleanSym, ...ownedSources]);
  const validSet = new Set(validDates);
  const toDelete = candidates.map(r => r.date).filter(d => !validSet.has(d));
  if (toDelete.length === 0) return 0;
  const delPlaceholders = toDelete.map(() => '?').join(',');
  await dbRun(`DELETE FROM price_history WHERE symbol = ? AND date IN (${delPlaceholders}) AND source IN (${placeholders})`, [cleanSym, ...toDelete, ...ownedSources]);
  return toDelete.length;
}

/**
 * Upsert the full company roster from staging into main DB's company_list, then
 * delete any row no longer present. Unlike price_history/dsex_market_history,
 * this table has no live writer of its own (no server/ job touches the
 * instrument roster) and no source/tier concept -- promotion is the only thing
 * that ever writes here, so a full sync needs no source-based scoping, just
 * "not in this complete payload -> no longer valid."
 */
export async function saveCompanyList(records = []) {
  if (!records.length) return { upserted: 0, pruned: 0 };
  await dbRun('BEGIN TRANSACTION');
  let upserted = 0;
  try {
    const stmt = dbPrepare(`
      INSERT INTO company_list (symbol, name, sector, category, listing_date, face_value, total_shares, market_cap_mn, is_active, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        name = excluded.name, sector = excluded.sector, category = excluded.category,
        listing_date = excluded.listing_date, face_value = excluded.face_value,
        total_shares = excluded.total_shares, market_cap_mn = excluded.market_cap_mn,
        is_active = excluded.is_active, fetched_at = excluded.fetched_at, source = excluded.source
    `);
    for (const r of records) {
      const symbol = (r.symbol || '').toUpperCase().trim();
      if (!symbol) continue;
      // This table has no live writer of its own -- everything in it comes
      // via promotion, so source is always STAGING_DB.
      stmt.run([symbol, r.name ?? null, r.sector ?? null, r.category ?? null, r.listing_date ?? null,
        r.face_value ?? null, r.total_shares ?? null, r.market_cap_mn ?? null, r.is_active ?? 1, r.fetched_at || new Date().toISOString(), 'STAGING_DB']);
      upserted++;
    }
    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }

  const validSymbols = new Set(records.map(r => (r.symbol || '').toUpperCase().trim()).filter(Boolean));
  const existing = await dbAll('SELECT symbol FROM company_list');
  const toDelete = existing.map(r => r.symbol).filter(s => !validSymbols.has(s));
  let pruned = 0;
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => '?').join(',');
    const r = await dbRun(`DELETE FROM company_list WHERE symbol IN (${placeholders})`, toDelete);
    pruned = r.changes ?? toDelete.length;
  }
  return { upserted, pruned };
}

/**
 * Writes one row to main DB's OWN audit_reports table -- called only by
 * server/audit/db_auditor.js at the end of a main-DB audit run, never by
 * promotion. See the schema comment in initDB() for why these two audit
 * histories (staging's, main's) are deliberately never synced with each other.
 */
export async function saveMainDBAuditReport({ targetEntity, recordsAudited, errorsCount, warningsCount, status, reportJson }) {
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [new Date().toISOString(), targetEntity, recordsAudited, errorsCount, warningsCount, status, reportJson ? JSON.stringify(reportJson) : null]);
}

// 2. Fetch Daily Closing Prices Timeline for a Stock directly from SQLite (1 record per calendar day)
export async function getHistoricalTimeline(symbol, limit = 7500) {
  const cleanSym = (symbol || '').toUpperCase().trim();
  let rows = await dbAll(`
    SELECT * FROM (
      SELECT SUBSTR(date, 1, 10) as fetchedAt, close as ltp, ycp, change, change_percent as changePercent, volume, pe
      FROM price_history
      WHERE symbol = ?
      GROUP BY SUBSTR(date, 1, 10)
      ORDER BY date DESC
      LIMIT ?
    ) ORDER BY fetchedAt ASC
  `, [cleanSym, limit]);

  // A symbol with few/no rows here genuinely has little or no history yet -- return
  // that honestly rather than fabricating a synthetic trajectory to fill the gap.
  return rows || [];
}


// 4. Save Company Fundamentals -- Job 3's daily delta writes straight into
// fundamentals_history now (company_fundamentals dropped 2026-08-23, see
// ARCHITECTURE.md). fundamentals_history's per-fiscal-year immutability is a
// promotion-time policy (an AUDITED disclosure, once promoted, never gets
// silently overwritten by a routine scrape) -- it was never meant to block
// Job 3's own legitimate updates to the CURRENT year's still-forming
// disclosure as new interim figures come in. The two are kept apart by
// audit_status: promotion always writes 'Audited' (see /api/ingest/fundamentals
// below, still INSERT...DO NOTHING); Job 3 always writes 'Provisional', and
// the ON CONFLICT clause below only fires when the existing row ISN'T
// 'Audited' -- so Job 3 can freely track/update a year it created itself, but
// can never touch a year that's already been through promotion.

// Null-safe change detection for saveFundamentalsBulkDelta's smart-delta skip
// logic: a plain `Number(oldVal) !== Number(newVal)` coerces null to 0, so
// "known -> genuinely unknown" and "known -> 0" become indistinguishable.
function valueChanged(oldVal, newVal) {
  if (oldVal === null && newVal === null) return false;
  if (oldVal === null || newVal === null) return true;
  return Number(oldVal) !== Number(newVal);
}

// 4b. O(1) In-Memory Smart Delta Bulk Fundamentals Ingestion (0 writes if unchanged)
export async function saveFundamentalsBulkDelta(records) {
  if (!records || !Array.isArray(records) || records.length === 0) {
    return { total: 0, changedCount: 0, unchangedCount: 0, changedSymbols: [] };
  }
  if (!isSqliteAvailable || !db) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  // Records without a resolvable fiscal_year can't target a (symbol,
  // fiscal_year) row at all -- skip rather than guess a year.
  const withYear = records.filter(r => r && r.symbol && (r.fiscalYear || r.fiscal_year));
  if (withYear.length === 0) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  // 1. Fetch current rows for exactly the (symbol, fiscal_year) pairs involved.
  // One batched query instead of one dbGet per pair -- Job 3 calls this with
  // up to ~640 symbols a day, and that used to mean ~640 sequential SQLite
  // round-trips just to check existing values before the upsert below.
  // SQLite has no clean row-value IN((?,?),(?,?),...) here (needs 3.15+ and
  // isn't consistently available), so this fetches every existing row for the
  // involved symbols in one query, then does the (symbol, fiscal_year) match
  // in JS -- still one round-trip regardless of how many years each symbol has.
  const keys = withYear.map(r => [String(r.symbol).toUpperCase().trim(), Number(r.fiscalYear ?? r.fiscal_year)]);
  const involvedSymbols = [...new Set(keys.map(([sym]) => sym))];
  const symPlaceholders = involvedSymbols.map(() => '?').join(',');
  const existingRows = involvedSymbols.length > 0
    ? await dbAll(`SELECT * FROM fundamentals_history WHERE symbol IN (${symPlaceholders})`, involvedSymbols)
    : [];
  const existingMap = new Map(); // "SYMBOL|YEAR" -> row
  for (const row of existingRows) {
    existingMap.set(`${row.symbol}|${row.fiscal_year}`, row);
  }

  const toUpdate = [];
  const changedSymbols = [];

  for (const r of withYear) {
    const sym = String(r.symbol).toUpperCase().trim();
    const yr = Number(r.fiscalYear ?? r.fiscal_year);
    const existing = existingMap.get(`${sym}|${yr}`);

    // An already-Audited (promoted) year is never touched by Job 3 -- not
    // even compared, since Job 3 has nothing legitimate to say about a
    // disclosure that's already been through the audit/promotion gate.
    if (existing && existing.audit_status === 'Audited') continue;

    if (!existing) {
      toUpdate.push({ ...r, symbol: sym, fiscalYear: yr });
      changedSymbols.push(sym);
      continue;
    }

    const epsNew = numOrNull(r.epsBasic) ?? numOrNull(r.eps);
    const navNew = numOrNull(r.navPerShare);
    const paidUpNew = numOrNull(r.paidUpCapitalMn) ?? numOrNull(r.paidUpCapital);
    const periodNew = r.auditedPeriod || null;
    const debtNew = numOrNull(r.debtToEquity);
    const crNew = numOrNull(r.currentRatio);

    // Number(null) is 0, so the old `Number(existing) !== Number(new)` comparison
    // would read "real value -> genuinely unknown" as "value -> 0" (a real change,
    // but the wrong one) or worse mask a real change whenever the existing value
    // happened to already be 0. valueChanged treats null explicitly instead of
    // coercing it through Number().
    const epsChanged = valueChanged(existing.eps_basic, epsNew);
    const navChanged = valueChanged(existing.nav_per_share, navNew);
    const paidUpChanged = valueChanged(existing.paid_up_capital_mn, paidUpNew);
    const periodChanged = existing.period !== periodNew;
    const debtChanged = valueChanged(existing.debt_to_equity, debtNew);
    const crChanged = valueChanged(existing.current_ratio, crNew);

    if (epsChanged || navChanged || paidUpChanged || periodChanged || debtChanged || crChanged) {
      toUpdate.push({ ...r, symbol: sym, fiscalYear: yr });
      changedSymbols.push(sym);
    }
  }

  if (toUpdate.length === 0) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  // 2. Perform compiled batch upsert for ONLY changed records
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO fundamentals_history (
        symbol, fiscal_year, period, eps_basic, eps_diluted, eps_quarterly,
        nav_per_share, paid_up_capital_mn, authorized_capital_mn,
        pe_ratio, pe_diluted, pe_trailing, dividend_yield, debt_to_equity, current_ratio,
        quarterly_disclosure, audit_status, source, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Provisional', ?, datetime('now'))
      ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
        period = excluded.period,
        eps_basic = excluded.eps_basic,
        eps_diluted = excluded.eps_diluted,
        eps_quarterly = excluded.eps_quarterly,
        nav_per_share = excluded.nav_per_share,
        paid_up_capital_mn = COALESCE(excluded.paid_up_capital_mn, fundamentals_history.paid_up_capital_mn),
        authorized_capital_mn = COALESCE(excluded.authorized_capital_mn, fundamentals_history.authorized_capital_mn),
        pe_ratio = excluded.pe_ratio,
        pe_diluted = excluded.pe_diluted,
        pe_trailing = excluded.pe_trailing,
        dividend_yield = excluded.dividend_yield,
        debt_to_equity = excluded.debt_to_equity,
        current_ratio = excluded.current_ratio,
        quarterly_disclosure = excluded.quarterly_disclosure,
        source = excluded.source,
        recorded_at = datetime('now')
      WHERE fundamentals_history.audit_status IS NOT 'Audited'
    `);

    for (const data of toUpdate) {
      stmt.run([
        data.symbol,
        data.fiscalYear,
        data.auditedPeriod || null,
        numOrNull(data.epsBasic) ?? numOrNull(data.eps),
        numOrNull(data.epsDiluted),
        numOrNull(data.epsQuarterly),
        numOrNull(data.navPerShare),
        numOrNull(data.paidUpCapitalMn) ?? numOrNull(data.paidUpCapital),
        numOrNull(data.authorizedCapitalMn) ?? numOrNull(data.authorizedCapital),
        numOrNull(data.peBasic) ?? numOrNull(data.pe),
        numOrNull(data.peDiluted),
        numOrNull(data.peTrailing),
        numOrNull(data.dividendYield),
        numOrNull(data.debtToEquity),
        numOrNull(data.currentRatio),
        data.quarterlyDisclosure || null,
        // Real live source -- this is Job 3's own DSE scrape, tracking a
        // still-forming period, distinct from a promoted/Audited disclosure.
        'DSE_OFFICIAL'
      ]);
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }

  return {
    total: records.length,
    changedCount: toUpdate.length,
    unchangedCount: records.length - toUpdate.length,
    changedSymbols
  };
}

// Shareholding pattern -- always a full overwrite of that symbol's one row
// (current + previous), never an append, per the "current snapshot only"
// product decision (see the table's own comment in initDB above). Records
// come from scrapeCompanyAuditedFinancials's `.shareholding` field.
export async function saveShareholdingCurrent(records) {
  if (!records || !Array.isArray(records) || records.length === 0) return { saved: 0 };
  if (!isSqliteAvailable || !db) return { saved: 0 };

  let saved = 0;
  for (const r of records) {
    if (!r || !r.symbol || !r.shareholding?.current) continue;
    const cur = r.shareholding.current;
    const prev = r.shareholding.previous;
    await dbRun(
      `INSERT INTO shareholding_current (
         symbol, sponsor_pct, govt_pct, institute_pct, foreign_pct, public_pct, as_of_date,
         prev_sponsor_pct, prev_govt_pct, prev_institute_pct, prev_foreign_pct, prev_public_pct, prev_as_of_date,
         updated_at, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'DSE_OFFICIAL')
       ON CONFLICT(symbol) DO UPDATE SET
         sponsor_pct = excluded.sponsor_pct, govt_pct = excluded.govt_pct, institute_pct = excluded.institute_pct,
         foreign_pct = excluded.foreign_pct, public_pct = excluded.public_pct, as_of_date = excluded.as_of_date,
         prev_sponsor_pct = excluded.prev_sponsor_pct, prev_govt_pct = excluded.prev_govt_pct,
         prev_institute_pct = excluded.prev_institute_pct, prev_foreign_pct = excluded.prev_foreign_pct,
         prev_public_pct = excluded.prev_public_pct, prev_as_of_date = excluded.prev_as_of_date,
         updated_at = excluded.updated_at, source = excluded.source`,
      [
        String(r.symbol).toUpperCase().trim(),
        cur.sponsorPct, cur.govtPct, cur.institutePct, cur.foreignPct, cur.publicPct, cur.asOfDate,
        prev?.sponsorPct ?? null, prev?.govtPct ?? null, prev?.institutePct ?? null,
        prev?.foreignPct ?? null, prev?.publicPct ?? null, prev?.asOfDate ?? null,
      ]
    );
    saved++;
  }
  return { saved };
}

export async function getShareholding(symbol) {
  if (!isSqliteAvailable || !db) return null;
  const row = await dbGet(`SELECT * FROM shareholding_current WHERE symbol = ?`, [String(symbol).toUpperCase().trim()]);
  if (!row) return null;
  return {
    current: {
      sponsorPct: row.sponsor_pct, govtPct: row.govt_pct, institutePct: row.institute_pct,
      foreignPct: row.foreign_pct, publicPct: row.public_pct, asOfDate: row.as_of_date,
    },
    previous: row.prev_as_of_date ? {
      sponsorPct: row.prev_sponsor_pct, govtPct: row.prev_govt_pct, institutePct: row.prev_institute_pct,
      foreignPct: row.prev_foreign_pct, publicPct: row.prev_public_pct, asOfDate: row.prev_as_of_date,
    } : null,
    updatedAt: row.updated_at,
  };
}

/** Symbols in a user's account-synced watchlist, most recently added first. */
export async function getUserWatchlist(userId) {
  if (!isSqliteAvailable || !db) return [];
  const rows = await dbAll(`SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? ORDER BY added_at DESC`, [userId]);
  return rows.map(r => r.symbol);
}

export async function addToUserWatchlist(userId, symbol) {
  const clean = String(symbol || '').toUpperCase().trim();
  if (!clean) return { added: false };
  await dbRun(
    `INSERT INTO user_watchlist (user_id, symbol) VALUES (?, ?) ON CONFLICT(user_id, symbol) DO NOTHING`,
    [userId, clean]
  );
  return { added: true, symbol: clean };
}

export async function removeFromUserWatchlist(userId, symbol) {
  const clean = String(symbol || '').toUpperCase().trim();
  await dbRun(`DELETE FROM user_watchlist WHERE user_id = ? AND symbol = ?`, [userId, clean]);
  return { removed: true, symbol: clean };
}

/**
 * One-time merge for a user's first sign-in: whatever they had in
 * localStorage before creating an account joins whatever (if anything)
 * already exists server-side, deduped -- neither side is silently discarded.
 * Idempotent (ON CONFLICT DO NOTHING), safe to call more than once.
 */
export async function mergeUserWatchlist(userId, symbols = []) {
  const clean = [...new Set(symbols.map(s => String(s || '').toUpperCase().trim()).filter(Boolean))];
  for (const symbol of clean) {
    await dbRun(`INSERT INTO user_watchlist (user_id, symbol) VALUES (?, ?) ON CONFLICT(user_id, symbol) DO NOTHING`, [userId, symbol]);
  }
  return getUserWatchlist(userId);
}

// "Current" fundamentals no longer live in their own table -- it's each
// symbol's most recent fiscal_year row in fundamentals_history (window
// function partitioned by symbol, latest year first), left-joined against
// company_list for name/sector/category since fundamentals_history never
// stored those (company_fundamentals dropped 2026-08-23, see ARCHITECTURE.md).
// face_value is exposed here too (2026-08-23 fix) -- getAllStocksFromDB's
// market-cap math used to hardcode /10, silently assuming every company's
// face value is 10 even for the 244 company_list rows where it's genuinely
// unknown (NULL). See DataAuditor.auditCompanyListRecord, which exists
// specifically to keep an unknown face_value as null instead of defaulting
// it -- the market-cap calc was quietly re-introducing that exact assumption
// downstream of the auditor that was built to prevent it.
const LATEST_FUNDAMENTALS_CTE = `
  WITH latest AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fiscal_year DESC) as rn
    FROM fundamentals_history
  )
  SELECT l.*, c.name as name, c.sector as sector, c.category as category, c.face_value as faceValue
  FROM latest l
  LEFT JOIN company_list c ON c.symbol = l.symbol
  WHERE l.rn = 1
`;

// 5. Get All Fundamentals map
export async function getAllFundamentalsMap() {
  const rows = await dbAll(LATEST_FUNDAMENTALS_CTE);
  const map = {};
  for (const r of rows) {
    map[r.symbol] = {
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      category: r.category,
      eps: r.eps_basic,
      epsDiluted: r.eps_diluted,
      navPerShare: r.nav_per_share,
      paidUpCapital: r.paid_up_capital_mn,
      peBasic: r.pe_ratio,
      peDiluted: r.pe_diluted,
      peTrailing: r.pe_trailing,
      dividendYield: r.dividend_yield,
      debtToEquity: r.debt_to_equity,
      currentRatio: r.current_ratio,
      auditedPeriod: r.period ? `FY${r.fiscal_year} ${r.period}` : `FY${r.fiscal_year}`,
      quarterlyDisclosure: r.quarterly_disclosure,
      updatedAt: r.recorded_at
    };
  }
  return map;
}

// 5c. Save Daily Closing DSEX Benchmark & Breadth (Dedicated for Job 1 - Appends only official EOD closing)
export async function saveDSEXDailyClosing(data, dateStr) {
  if (!data) return;
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  // dsex_index is NOT NULL in the schema (it's the permanent historical record),
  // so there's no honest way to persist "unknown" for it the way the other fields
  // use null. The old `|| 0` fallback meant a failed scrape would silently write a
  // literal DSEX=0 into 20-year history -- the previous close being a few thousand
  // points, that's about as clearly wrong as a value can be. Skip the write
  // entirely instead: no row today is correct; a fabricated 0 is not.
  const dsexIndex = data.dsexIndex !== null && data.dsexIndex !== undefined && Number(data.dsexIndex) > 0
    ? Number(data.dsexIndex)
    : null;
  if (dsexIndex === null) {
    console.warn(`[SQLITE] saveDSEXDailyClosing: no real DSEX value for ${targetDate}, skipping write (not fabricating).`);
    return;
  }

  // Tier-priority guard -- see tierAllowsOverwrite in shared/source_tiers.js.
  const existing = await dbGet(`SELECT source FROM dsex_market_history WHERE date = ?`, [targetDate]);
  if (!tierAllowsOverwrite(existing?.source, data.source)) {
    console.warn(`[SQLITE] saveDSEXDailyClosing: skipped for ${targetDate} -- existing row already has a better/equal-tier source (${existing.source} vs incoming ${data.source}).`);
    return;
  }

  await dbRun(`
    INSERT INTO dsex_market_history (
      date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      dsex_index = excluded.dsex_index,
      advancing = excluded.advancing,
      declining = excluded.declining,
      unchanged = excluded.unchanged,
      total_trades = excluded.total_trades,
      total_volume = excluded.total_volume,
      total_value_mn = excluded.total_value_mn,
      source = COALESCE(excluded.source, dsex_market_history.source)
  `, [
    targetDate,
    dsexIndex,
    data.advancing ?? null,
    data.declining ?? null,
    data.unchanged ?? null,
    data.totalTrades ?? null,
    data.totalVolume ?? null,
    data.totalValueMn ?? null,
    data.source || null
  ]);
}

/**
 * Deletes dsex_market_history rows the staging pipeline no longer has, so a
 * promotion run acts as a real sync instead of upsert-only. Scoped two ways
 * for safety: only rows whose source is one PROMOTION_OWNED_SOURCES.
 * dsex_market_history lists (never DSE_LIVE_CLOSING/DSE_LIVE_TICKER, which
 * server's own Job 1/Job 2 write directly and promotion has no business
 * touching), and only dates NOT in `validDates` -- the complete current
 * stg_index_history date set the promoter always sends in one call.
 *
 * Real incident this fixes (2026-08-23): 60 dsex_market_history rows
 * (KAGGLE/MCAP_WEIGHTED_ESTIMATE) were deleted from staging after being found
 * to not hold up (49 dated on non-trading weekend days, 8 showing implausible
 * reverting spikes) -- but promotion being upsert-only meant they silently
 * stayed in the main DB, promoted in an earlier run, with nothing to remove
 * them. Required a manual one-off DELETE to fix; this makes it automatic.
 */
export async function pruneOrphanedDSEXRows(validDates) {
  // Safety guard, added 2026-08-23 after this exact call wiped all 3,231 rows
  // during a routine endpoint test: an EMPTY incoming set must never be
  // read as "staging now has zero rows, delete everything" -- a genuine
  // promotion always carries real data (manual_promoter.js only calls this
  // path when dsexRows.length > 0), so an empty call is either a malformed
  // request, a bug in a caller, or a test -- never a legitimate "clear the
  // table" instruction. Deliberately clearing this table is a separate,
  // explicit action (direct SQL, with a backup first), not a side effect of
  // calling the ingest endpoint with nothing in it.
  if (!validDates || validDates.length === 0) {
    console.warn('[SQLITE] pruneOrphanedDSEXRows: called with an empty valid-dates set -- refusing to prune (would delete every STAGING_DB row). No-op.');
    return 0;
  }
  const ownedSources = PROMOTION_OWNED_SOURCES.dsex_market_history;
  const placeholders = ownedSources.map(() => '?').join(',');
  const candidates = await dbAll(`SELECT date, source FROM dsex_market_history WHERE source IN (${placeholders})`, ownedSources);
  const validSet = new Set(validDates);
  const toDelete = candidates.filter(r => !validSet.has(r.date)).map(r => r.date);
  if (toDelete.length === 0) return 0;
  const delPlaceholders = toDelete.map(() => '?').join(',');
  await dbRun(`DELETE FROM dsex_market_history WHERE date IN (${delPlaceholders}) AND source IN (${placeholders})`, [...toDelete, ...ownedSources]);
  console.warn(`[SQLITE] pruneOrphanedDSEXRows: removed ${toDelete.length} row(s) no longer present in staging.`);
  return toDelete.length;
}

// 5d. Get 20-Year DSEX Historical Timeline
export async function getDSEXHistoricalTimeline(limit = 7500) {
  // No auto-seed fallback here: if there's real data, return it; if there's not
  // (or not much), that's the honest answer -- never top it up with fabricated rows.
  let rows = await dbAll(`
    SELECT date, dsex_index as dsexIndex, advancing, declining, unchanged, total_value_mn as turnoverMn, total_volume as volume, source
    FROM dsex_market_history
    ORDER BY date ASC
    LIMIT ?
  `, [limit]);

  // Tier quality (source) used to exist in the schema but never reach this API.
  // As of 2026-08-23 the staging table this promotes from is 98%+ Tier 1 (see
  // ARCHITECTURE.md) after a real dsebd.org chart endpoint was found and used
  // to upgrade the Tier 3 rows / remove the ones that didn't hold up -- still
  // exposed as both raw source and numeric tier so a consumer isn't left
  // assuming every value here is DSE-official without a way to check.
  return (rows || []).map(r => ({ ...r, tier: tierOf(r.source) }));
}

// 5c. Fetch Complete Equities List directly from SQLite DB (Latest Audited Fundamentals + Latest Daily Closing)
export async function getAllStocksFromDB() {
  let rows = [];
  if (isSqliteAvailable && db) {
    try {
      rows = await dbAll(`
        SELECT
          f.symbol,
          f.name as fullName,
          f.sector,
          f.category,
          f.eps_basic as eps,
          f.eps_diluted as epsDiluted,
          f.nav_per_share as navPerShare,
          f.paid_up_capital_mn as paidUpCapital,
          f.authorized_capital_mn as authorizedCapital,
          f.dividend_yield as dividendYield,
          f.fiscal_year as fiscalYear,
          f.period as period,
          f.quarterly_disclosure as quarterlyDisclosure,
          f.faceValue,
          p.date as closeDate,
          p.close as ltp,
          p.ycp,
          p.change,
          p.change_percent as changePercent,
          p.volume,
          p.pe,
          (p.change_percent) as momentum,
          f.debt_to_equity as debtToEquity,
          f.current_ratio as currentRatio
        FROM (${LATEST_FUNDAMENTALS_CTE}) f
        LEFT JOIN (
          SELECT ph1.symbol, ph1.date, ph1.close, ph1.ycp, ph1.change, ph1.change_percent, ph1.volume, ph1.pe
          FROM price_history ph1
          INNER JOIN (
            SELECT symbol, MAX(date) as max_date
            FROM price_history
            WHERE date NOT LIKE '%T%' AND date NOT LIKE '%:%'
            GROUP BY symbol
          ) ph2 ON ph1.symbol = ph2.symbol AND ph1.date = ph2.max_date
        ) p ON f.symbol = p.symbol
        ORDER BY f.symbol ASC
      `);
    } catch (e) {
      console.warn('[SQLITE] getAllStocksFromDB query notice:', e.message);
    }
  }

  if (rows && rows.length > 0) {
    return rows.map(r => {
      const ltp = r.ltp !== null ? Number(r.ltp) : null;
      const ycp = r.ycp !== null ? Number(r.ycp) : null;
      const eps = r.eps !== null ? Number(r.eps) : null;
      const navPerShare = r.navPerShare !== null ? Number(r.navPerShare) : null;
      const paidUpCapital = r.paidUpCapital !== null ? Number(r.paidUpCapital) : null;
      
      const change = (ltp !== null && ycp !== null && ycp > 0)
        ? Number((ltp - ycp).toFixed(2))
        : (r.change !== null ? Number(r.change) : null);

      const changePercent = (ltp !== null && ycp !== null && ycp > 0)
        ? Number((((ltp - ycp) / ycp) * 100).toFixed(2))
        : (r.changePercent !== null ? Number(r.changePercent) : null);

      const volume = r.volume !== null ? Number(r.volume) : null;

      const dailyPe = (ltp && eps && eps > 0)
        ? Number((ltp / eps).toFixed(2))
        : (r.pe !== null ? Number(r.pe) : null);

      const auditedPe = (ycp && eps && eps > 0)
        ? Number((ycp / eps).toFixed(2))
        : dailyPe;

      const roe = (eps !== null && navPerShare !== null && navPerShare > 0)
        ? Number(((eps / navPerShare) * 100).toFixed(2))
        : null;

      // No hardcoded /10: that silently assumed every company's face value is
      // 10 -- true for the ~62% of company_list rows where face_value is
      // actually 10, but 244 rows (mostly bonds/T-bills/funds added later)
      // have a genuinely unknown face_value (NULL), and this used to compute
      // a market cap for them anyway as if 10 were confirmed. paidUpCapitalMn
      // / faceValue gives the real share count in millions; an unknown face
      // value means market cap genuinely can't be derived, so it stays null
      // rather than guessing -- same rule DataAuditor.auditCompanyListRecord
      // already enforces on face_value itself.
      const faceValue = numOrNull(r.faceValue);
      const marketCap = (ltp !== null && paidUpCapital !== null && faceValue !== null && faceValue > 0)
        ? Number(((paidUpCapital / faceValue) * ltp).toFixed(2))
        : null;

      const auditedPeriod = r.fiscalYear ? `FY${r.fiscalYear}${r.period ? ' ' + r.period : ''}` : null;

      return {
        ...r,
        ltp,
        ycp,
        change,
        changePercent,
        momentum: changePercent,
        volume,
        pe: dailyPe,
        dailyPe,
        auditedPe,
        eps,
        navPerShare,
        paidUpCapital,
        authorizedCapital: r.authorizedCapital !== null ? Number(r.authorizedCapital) : null,
        dividendYield: r.dividendYield !== null ? Number(r.dividendYield) : null,
        debtToEquity: r.debtToEquity !== null ? Number(r.debtToEquity) : null,
        currentRatio: r.currentRatio !== null ? Number(r.currentRatio) : null,
        roe,
        marketCap,
        faceValue,
        closeDate: r.closeDate || null,
        auditedPeriod
      };
    });
  }

  // Master Snapshot Zero-Fail Fallback (Bundled 440 scrips with authentic audited fundamentals)
  const JSON_PATH = path.join(DATA_DIR, 'latest.json');
  if (fs.existsSync(JSON_PATH)) {
    const raw = fs.readFileSync(JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const stocks = parsed.stocks || parsed;
    if (Array.isArray(stocks) && stocks.length > 0) {
      return stocks;
    }
  }

  return [];
}

// In-Memory High-Speed Cache for Macro DSEX Trajectory (Refreshes hourly)
let cachedDsexMap = null;
let lastDsexFetchTime = 0;

export async function getCachedDSEXMap() {
  const now = Date.now();
  if (cachedDsexMap && (now - lastDsexFetchTime < 3600000)) {
    return cachedDsexMap;
  }
  const map = new Map();
  try {
    const rows = await dbAll('SELECT date, dsex_index as dsexIndex FROM dsex_market_history ORDER BY date ASC');
    for (const d of rows) {
      if (d.date && d.dsexIndex) {
        map.set(d.date, Number(d.dsexIndex));
      }
    }
    cachedDsexMap = map;
    lastDsexFetchTime = now;
  } catch (e) {
    console.warn('[SQLITE] getCachedDSEXMap notice:', e.message);
  }
  return map;
}

// In-Memory Fast Cache for 20-Year Detailed Quantitative Models
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateAnalysisCache(symbol = null) {
  if (symbol) {
    analysisCache.delete(String(symbol).toUpperCase().trim());
  } else {
    analysisCache.clear();
  }
}

// 9. Quantitative 20-Year Detailed Historical Analysis Engine
export async function getDetailedHistoricalAnalysis(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return null;

  // Check in-memory cache for sub-millisecond response
  const cached = analysisCache.get(cleanSym);
  if (cached && (Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL)) {
    return cached.data;
  }

  // 1. Fetch all raw historical daily prices
  let rows = await dbAll(`
    SELECT date, close as ltp, ycp, change, change_percent as changePercent, volume, value_mn, pe
    FROM price_history
    WHERE symbol = ? AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
    ORDER BY date ASC
  `, [cleanSym]);

  // 2. Fetch fundamentals -- latest fiscal_year row for this symbol (see
  // LATEST_FUNDAMENTALS_CTE; company_fundamentals dropped 2026-08-23).
  const fund = await dbGet(`
    SELECT * FROM fundamentals_history WHERE symbol = ? ORDER BY fiscal_year DESC LIMIT 1
  `, [cleanSym]);

  // 2b. Every fiscal year's audited P/E for this symbol -- the valuation
  // corridor/mean reversion model below (section C/D) needs a real
  // multi-year P/E sample. price_history.pe is NOT a viable source for this:
  // no scraper we run (DSE bulletin, LankaBD) publishes a per-day historical
  // P/E, so that column is 100% null across the entire archive (verified
  // 2026-08-23 -- 0 of 1.1M rows). fundamentals_history.pe_ratio (year_end_close
  // / eps, computed by pipeline/src/builders/analytics_engine.js) is the only
  // real historical P/E this system actually has.
  const fundamentalsHistoryRows = await dbAll(`
    SELECT fiscal_year, pe_ratio FROM fundamentals_history WHERE symbol = ? ORDER BY fiscal_year ASC
  `, [cleanSym]);
  // name/sector/category now live in company_list, not fundamentals_history.
  // face_value added (2026-08-23) to compute marketCap below the same
  // face_value-aware way getAllStocksFromDB does -- this function used to
  // have no market cap field at all, so there was no hardcoded-/10 bug to
  // inherit here, but it must not introduce one now.
  const companyInfo = await dbGet(`SELECT name, sector, category, face_value FROM company_list WHERE symbol = ?`, [cleanSym]);

  // No fabricated fallback -- a symbol with zero rows here genuinely has no
  // history in the DB yet; the rest of this function already handles a sparse
  // or empty `rows` honestly (see the frontend's "unavailable" states).

  if (!rows || rows.length === 0) {
    return null;
  }

  const latestRow = rows[rows.length - 1];
  // No `|| 0` needed: ltp here is `close as ltp` from price_history, and `close`
  // is NOT NULL in the schema -- it can never actually be missing.
  const currentPrice = Number(latestRow.ltp);
  const eps = numOrNull(fund?.eps_basic);
  const navps = numOrNull(fund?.nav_per_share);
  const currentPe = (currentPrice > 0 && eps && eps > 0) ? Number((currentPrice / eps).toFixed(2)) : (latestRow.pe || null);

  // Same 4 fields StockModal.jsx shows in its "Audited Financial Disclosures"
  // section that this endpoint didn't previously return at all -- added
  // 2026-08-23 so the deep-dive page can show them without a second request.
  const ycp = numOrNull(latestRow.ycp);
  // Audited P/E: yesterday's close against audited EPS (matches
  // getAllStocksFromDB's auditedPe exactly) -- distinct from currentPe above,
  // which uses today's live price and is the "daily" P/E, not the audited one.
  const auditedPe = (ycp && eps && eps > 0) ? Number((ycp / eps).toFixed(2)) : currentPe;
  const paidUpCapital = numOrNull(fund?.paid_up_capital_mn);
  const dividendYield = numOrNull(fund?.dividend_yield);
  // Same face-value-aware calc as getAllStocksFromDB (fixed 2026-08-23) --
  // never hardcode /10, that silently assumes every company's face value is
  // 10 when company_list.face_value may genuinely be unknown (null) for this
  // symbol; market cap stays null rather than guessing in that case.
  const faceValue = numOrNull(companyInfo?.face_value);
  const marketCap = (currentPrice > 0 && paidUpCapital !== null && faceValue !== null && faceValue > 0)
    ? Number(((paidUpCapital / faceValue) * currentPrice).toFixed(2))
    : null;

  // A. All-Time High (ATH) & All-Time Low (ATL)
  let athPrice = -Infinity;
  let athDate = '';
  let atlPrice = Infinity;
  let atlDate = '';

  // Max Historical Drawdown (MDD)
  let runningPeak = -Infinity;
  let maxDrawdown = 0;
  let mddPeakDate = '';
  let mddTroughDate = '';

  const validPes = [];
  const pricesArray = [];

  for (const r of rows) {
    const p = Number(r.ltp); // same NOT NULL guarantee as currentPrice above
    if (p <= 0) continue;
    pricesArray.push(p);

    if (p > athPrice) {
      athPrice = p;
      athDate = r.date;
    }
    if (p < atlPrice) {
      atlPrice = p;
      atlDate = r.date;
    }

    if (p > runningPeak) {
      runningPeak = p;
    }
    const currentDd = ((p - runningPeak) / runningPeak) * 100;
    if (currentDd < maxDrawdown) {
      maxDrawdown = currentDd;
      mddPeakDate = athDate;
      mddTroughDate = r.date;
    }

    const peVal = Number(r.pe);
    if (!isNaN(peVal) && peVal > 0 && peVal < 120) {
      validPes.push(peVal);
    }
  }

  // Real historical P/E sample -- see the fundamentalsHistoryRows comment above
  // for why this (not price_history.pe) is the actual source.
  for (const fh of fundamentalsHistoryRows) {
    const peVal = Number(fh.pe_ratio);
    if (!isNaN(peVal) && peVal > 0 && peVal < 120) {
      validPes.push(peVal);
    }
  }

  const currentDrawdownFromATH = athPrice > 0 ? Number((((currentPrice - athPrice) / athPrice) * 100).toFixed(2)) : 0;
  const currentRiseFromATL = atlPrice > 0 ? Number((((currentPrice - atlPrice) / atlPrice) * 100).toFixed(2)) : 0;

  // B. Moving Averages (SMA50 & SMA200)
  const last50 = pricesArray.slice(-50);
  const last200 = pricesArray.slice(-200);

  const sma50 = last50.length > 0 ? Number((last50.reduce((a, b) => a + b, 0) / last50.length).toFixed(2)) : currentPrice;
  const sma200 = last200.length > 0 ? Number((last200.reduce((a, b) => a + b, 0) / last200.length).toFixed(2)) : currentPrice;

  let trendSignal = 'Neutral Accumulation';
  if (sma50 > sma200 && currentPrice > sma50) {
    trendSignal = 'Bullish Golden Cross (Above SMA50 & SMA200)';
  } else if (sma50 < sma200 && currentPrice < sma50) {
    trendSignal = 'Bearish Consolidation (Below SMA50 & SMA200)';
  } else if (currentPrice > sma200) {
    trendSignal = 'Long-Term Structural Support (Above SMA200)';
  }

  // C. Historical Valuation Corridors & Percentile Rank
  validPes.sort((a, b) => a - b);
  let medianPe = null;
  let p25Pe = null;
  let p75Pe = null;
  let pePercentileRank = null;

  if (validPes.length > 0) {
    medianPe = Number(validPes[Math.floor(validPes.length * 0.5)].toFixed(2));
    p25Pe = Number(validPes[Math.floor(validPes.length * 0.25)].toFixed(2));
    p75Pe = Number(validPes[Math.floor(validPes.length * 0.75)].toFixed(2));

    if (currentPe !== null) {
      const lowerCount = validPes.filter(v => v < currentPe).length;
      pePercentileRank = Math.round((lowerCount / validPes.length) * 100);
    }
  }

  // D. Mean Reversion Model
  let meanReversionTargetPrice = null;
  let meanReversionUpside = null;
  if (medianPe !== null && eps !== null && eps > 0) {
    meanReversionTargetPrice = Number((eps * medianPe).toFixed(2));
    if (currentPrice > 0) {
      meanReversionUpside = Number((((meanReversionTargetPrice - currentPrice) / currentPrice) * 100).toFixed(2));
    }
  }

  // E. Graham Intrinsic Value & Treasury Bond Spread
  let grahamNumber = null;
  let marginOfSafety = null;
  if (eps !== null && eps > 0 && navps !== null && navps > 0) {
    grahamNumber = Number(Math.sqrt(22.5 * eps * navps).toFixed(2));
    if (currentPrice > 0) {
      marginOfSafety = Number((((grahamNumber - currentPrice) / grahamNumber) * 100).toFixed(2));
    }
  }

  const earningsYield = currentPe !== null && currentPe > 0 ? Number(((1 / currentPe) * 100).toFixed(2)) : null;
  const bondSpread = earningsYield !== null ? Number((earningsYield - 11.50).toFixed(2)) : null;

  // F. 20-Year DSE Macro & Market Catalysts Mapping
  const macroCatalysts = [
    {
      date: '2010-12-05',
      type: 'Market Crash',
      title: '2010 Great DSE Bubble Peak & Collapse',
      badge: '💥 2010 Crash',
      desc: 'Excessive margin lending drove DSEX index to peak ~8,900 before credit contraction triggered a massive multi-year liquidity unwind.'
    },
    {
      date: '2020-03-19',
      type: 'Regulatory',
      title: 'COVID-19 Shock & Floor Price 1.0',
      badge: '🛡️ Floor Price 1.0',
      desc: 'BSEC introduced mandatory minimum floor prices to prevent panic liquidation during global lockdown shocks.'
    },
    {
      date: '2021-09-09',
      type: 'Bull Market',
      title: 'Post-Pandemic Liquidity Expansion Peak',
      badge: '🚀 2021 Bull Run',
      desc: 'DSEX surged past 7,368 on low interest rates, money supply growth, and corporate earnings recovery.'
    },
    {
      date: '2022-07-28',
      type: 'Liquidity Freeze',
      title: 'FX Shortage & Floor Price 2.0 Reinstatement',
      badge: '🔒 Floor Price 2.0',
      desc: 'Severe import dollar shortages and Taka devaluation led to reinstating floor prices, freezing trading turnover across equities.'
    },
    {
      date: '2024-01-18',
      type: 'Market Normalization',
      title: 'Phased Floor Price Removal',
      badge: '🔓 Floor Lifted',
      desc: 'Regulators phased out artificial price floors, restoring natural free-market price discovery and foreign investor interest.'
    },
    {
      date: '2024-08-05',
      type: 'Macro Reform',
      title: 'National Governance Transition & Banking Clean-up',
      badge: '🏛️ Reform Cycle',
      desc: 'Bangladesh Bank leadership change, interest rate hike to tame inflation, and non-performing loan resolution frameworks.'
    }
  ];

  // G. Historical Cycle Breakdown
  const historicalCycles = [
    {
      period: '2005 – 2010',
      title: 'The Great DSE Bull Run',
      driver: 'Rapid retail participation, margin loan expansion, and banking sector IPOs pushed valuations to historic bubble extremes.',
      outcome: `Equities reached peak valuations with ${cleanSym} reaching ATH of ৳${athPrice > 0 ? athPrice.toFixed(2) : '—'} on ${athDate || '2010'}.`
    },
    {
      period: '2011 – 2019',
      title: 'Post-Crash Deleveraging & Base Building',
      driver: 'Forced margin liquidations, regulatory tightening by BSEC, and bank provisioning requirements.',
      outcome: `Structural consolidation cycle where ${cleanSym} recorded Max Drawdown of ${maxDrawdown.toFixed(2)}%.`
    },
    {
      period: '2020 – 2023',
      title: 'COVID & Floor Price Interventions',
      driver: 'Pandemic disruptions followed by macro currency devaluation and regulatory price floors.',
      outcome: 'Artificial floor prices provided downside support but severely restricted daily turnover and trading volume.'
    },
    {
      period: '2024 – 2026',
      title: 'Price Discovery & Generational Value Re-accumulation',
      driver: 'Removal of floor prices, tight monetary policy, and transparent audited disclosure mandates.',
      outcome: `Stock is trading at P/E of ${currentPe !== null ? currentPe.toFixed(2) + 'x' : 'N/A'} (Percentile: ${pePercentileRank !== null ? pePercentileRank + 'th' : 'N/A'}), offering an institutional mean-reversion setup.`
    }
  ];

  // Fast DSEX Map Lookup (0ms overhead via memory cache)
  const dsexMap = await getCachedDSEXMap();
  const timeline = rows.map(r => ({
    date: r.date,
    price: Number(r.ltp),
    volume: numOrNull(r.volume),
    pe: r.pe !== null ? Number(r.pe) : null,
    dsex: dsexMap.get(r.date) || null
  }));

  // Fetch 20-Year Financial Statements safely
  let financialStatements = [];
  try {
    financialStatements = await dbAll(`
      SELECT fiscal_year as year, period, eps_basic as eps, nav_per_share as navps,
             roe, dividend_yield as dividendYield, dps, pe_ratio as pe, debt_to_equity as debtToEquity,
             current_ratio as currentRatio, paid_up_capital_mn as paidUpCapital, audit_status as auditStatus
      FROM fundamentals_history
      WHERE symbol = ?
      ORDER BY fiscal_year DESC
    `, [cleanSym]);
  } catch {
    financialStatements = [];
  }

  // No fabricated fallback: a symbol with no real rows in fundamentals_history
  // simply has no audited statements on file yet. The previous version here
  // synthesized 20 years of fake EPS/NAV/ROE/dividend/P/E figures via sine-wave
  // noise around a single base value and tagged the result `auditStatus:
  // 'Audited'` -- asserting fabricated numbers were real audited disclosures.
  // financialStatements stays [] here; the frontend already renders a "no
  // audited statements available" state for that case.

  // H. Volatility, Beta vs DSEX, and a Sharpe-style risk-adjusted return
  // (2026-08-24) -- daily log-ish returns from the same real price_history
  // series already loaded above; DSEX side comes from the same dsexMap the
  // benchmark-overlay chart already uses, paired by date so a day missing
  // on either side is dropped rather than treated as a 0% return.
  let riskMetrics = { annualizedVolatilityPercent: null, beta: null, sharpeRatio: null };
  {
    const pairedReturns = [];
    for (let i = 1; i < rows.length; i++) {
      const p0 = Number(rows[i - 1].ltp);
      const p1 = Number(rows[i].ltp);
      if (p0 <= 0 || p1 <= 0) continue;
      const stockRet = (p1 - p0) / p0;
      const dsex0 = dsexMap.get(rows[i - 1].date);
      const dsex1 = dsexMap.get(rows[i].date);
      const dsexRet = (dsex0 && dsex1 && dsex0 > 0) ? (dsex1 - dsex0) / dsex0 : null;
      pairedReturns.push({ stockRet, dsexRet });
    }
    if (pairedReturns.length >= 30) {
      const stockRets = pairedReturns.map(r => r.stockRet);
      const mean = stockRets.reduce((a, b) => a + b, 0) / stockRets.length;
      const variance = stockRets.reduce((a, b) => a + (b - mean) ** 2, 0) / stockRets.length;
      const dailyStdev = Math.sqrt(variance);
      const annualizedVol = dailyStdev * Math.sqrt(252) * 100;
      riskMetrics.annualizedVolatilityPercent = Number(annualizedVol.toFixed(2));

      const withDsex = pairedReturns.filter(r => r.dsexRet !== null);
      if (withDsex.length >= 30) {
        const dsexRets = withDsex.map(r => r.dsexRet);
        const sRets = withDsex.map(r => r.stockRet);
        const sMean = sRets.reduce((a, b) => a + b, 0) / sRets.length;
        const dMean = dsexRets.reduce((a, b) => a + b, 0) / dsexRets.length;
        let cov = 0, dsexVar = 0;
        for (let i = 0; i < withDsex.length; i++) {
          cov += (sRets[i] - sMean) * (dsexRets[i] - dMean);
          dsexVar += (dsexRets[i] - dMean) ** 2;
        }
        cov /= withDsex.length;
        dsexVar /= withDsex.length;
        if (dsexVar > 0) riskMetrics.beta = Number((cov / dsexVar).toFixed(2));
      }

      // Sharpe-style: full-period price CAGR vs the same 11.5% govt bond
      // benchmark already used elsewhere on this page (earningsYield/
      // bondSpread above), over annualized volatility.
      const firstPrice = Number(rows[0].ltp);
      const yearsSpanned = (new Date(latestRow.date) - new Date(rows[0].date)) / (365.25 * 24 * 3600 * 1000);
      if (firstPrice > 0 && currentPrice > 0 && yearsSpanned > 0.5 && annualizedVol > 0) {
        const periodCagr = (Math.pow(currentPrice / firstPrice, 1 / yearsSpanned) - 1) * 100;
        riskMetrics.sharpeRatio = Number(((periodCagr - 11.5) / annualizedVol).toFixed(2));
      }
    }
  }

  // I. Multi-period CAGR / total-return table (2026-08-24) -- price-only
  // CAGR plus a "total return" approximation that adds cash dividends paid
  // during the window to the ending value (not compounded/reinvested share
  // by share -- a simpler, honestly-labeled approximation, not a true DRIP
  // simulation). dps comes from financialStatements (real, audited).
  const returnsTable = [];
  {
    const periods = [{ label: '1Y', years: 1 }, { label: '3Y', years: 3 }, { label: '5Y', years: 5 }, { label: '10Y', years: 10 }];
    const latestDate = new Date(latestRow.date);
    for (const { label, years } of periods) {
      const targetDate = new Date(latestDate);
      targetDate.setFullYear(targetDate.getFullYear() - years);
      // Nearest available trading day on/after the target date -- rows is
      // date-ascending, so the first match walking forward is closest.
      const startRow = rows.find(r => new Date(r.date) >= targetDate);
      if (!startRow || Number(startRow.ltp) <= 0) continue;
      // Require the start row to actually be close to the target (within
      // ~45 days) -- otherwise a stock listed only 2 years ago would get a
      // fabricated-looking "10Y return" computed from its IPO-era first
      // trade instead of honestly having no 10Y figure at all.
      if (Math.abs(new Date(startRow.date) - targetDate) > 45 * 24 * 3600 * 1000) continue;

      const startPrice = Number(startRow.ltp);
      const actualYears = (latestDate - new Date(startRow.date)) / (365.25 * 24 * 3600 * 1000);
      if (actualYears < years * 0.7) continue; // not enough real history for this bucket

      const priceCagr = (Math.pow(currentPrice / startPrice, 1 / actualYears) - 1) * 100;

      const dpsInWindow = financialStatements
        .filter(s => s.year >= startRow.date.slice(0, 4) && s.dps !== null && s.dps !== undefined)
        .reduce((sum, s) => sum + Number(s.dps), 0);
      const totalReturnCagr = dpsInWindow > 0
        ? (Math.pow((currentPrice + dpsInWindow) / startPrice, 1 / actualYears) - 1) * 100
        : priceCagr;

      returnsTable.push({
        period: label,
        priceCagrPercent: Number(priceCagr.toFixed(2)),
        totalReturnCagrPercent: Number(totalReturnCagr.toFixed(2)),
        startDate: startRow.date,
      });
    }
  }

  // J. EPS & NAVPS CAGR (2026-08-24) -- the two core "is this actually a
  // compounder" growth rates, from the same real audited financialStatements
  // already fetched above. Uses the earliest and latest year that both have
  // a positive value -- a year with a loss (negative/zero EPS) as either
  // endpoint makes a CAGR meaningless (or undefined for a sign flip), so
  // those years are skipped as endpoints rather than silently producing a
  // nonsensical growth rate.
  function growthCagr(field) {
    const sorted = [...financialStatements].sort((a, b) => a.year - b.year);
    const withVal = sorted.filter(s => s[field] !== null && s[field] !== undefined && Number(s[field]) > 0);
    if (withVal.length < 2) return null;
    const first = withVal[0];
    const last = withVal[withVal.length - 1];
    const yearsSpanned = last.year - first.year;
    if (yearsSpanned <= 0) return null;
    const cagr = (Math.pow(Number(last[field]) / Number(first[field]), 1 / yearsSpanned) - 1) * 100;
    return { cagrPercent: Number(cagr.toFixed(2)), fromYear: first.year, toYear: last.year, fromValue: Number(first[field]), toValue: Number(last[field]) };
  }
  const fundamentalsGrowth = {
    epsCagr: growthCagr('eps'),
    navpsCagr: growthCagr('navps'),
  };

  // K. 52-week high/low (2026-08-24) -- distinct from the all-time ATH/ATL
  // above; this is the standard trailing-year reference point.
  let week52 = { high: null, low: null, percentOffHigh: null };
  {
    const cutoff = new Date(latestRow.date);
    cutoff.setDate(cutoff.getDate() - 365);
    const window = rows.filter(r => new Date(r.date) >= cutoff && Number(r.ltp) > 0);
    if (window.length > 0) {
      const prices = window.map(r => Number(r.ltp));
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      week52 = {
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        percentOffHigh: high > 0 ? Number((((currentPrice - high) / high) * 100).toFixed(2)) : null,
      };
    }
  }

  // L. Liquidity profile (2026-08-24) -- average daily traded value (BDT mn)
  // over the trailing ~90 sessions, bucketed into a plain-language label. The
  // thresholds are a reasonable heuristic for this market, not a regulatory
  // or industry-standard definition -- presented as a rough read on "can you
  // actually size into/out of this name," not a precise metric.
  let liquidity = { avgDailyVolume: null, avgDailyValueMn: null, classification: null };
  {
    const recent = rows.slice(-90);
    const withVolume = recent.filter(r => r.volume !== null && r.volume !== undefined);
    const withValue = recent.filter(r => r.value_mn !== null && r.value_mn !== undefined);
    if (withVolume.length > 0) {
      liquidity.avgDailyVolume = Math.round(withVolume.reduce((a, r) => a + Number(r.volume), 0) / withVolume.length);
    }
    if (withValue.length > 0) {
      const avgVal = withValue.reduce((a, r) => a + Number(r.value_mn), 0) / withValue.length;
      liquidity.avgDailyValueMn = Number(avgVal.toFixed(2));
      liquidity.classification = avgVal < 1 ? 'Illiquid' : avgVal < 10 ? 'Moderate' : 'Liquid';
    }
  }

  // M. Sector P/E percentile trend over time (2026-08-24) -- same direction
  // convention as the Sector Standing radar on this same page (services/
  // dseData.js's percentileRank: higher percentile = cheaper/better, i.e.
  // more peers have a HIGHER P/E than this stock that year), computed here
  // per fiscal year instead of just today's snapshot. Needs every peer's
  // audited P/E for each year, not just this stock's -- a separate query
  // against the whole sector, not derivable from fundamentalsHistoryRows
  // (this stock only) above.
  let sectorPercentileTrend = [];
  if (companyInfo?.sector) {
    const peerRows = await dbAll(`
      SELECT fh.fiscal_year, fh.symbol, fh.pe_ratio
      FROM fundamentals_history fh
      JOIN company_list cl ON cl.symbol = fh.symbol
      WHERE cl.sector = ? AND fh.pe_ratio IS NOT NULL AND fh.pe_ratio > 0
    `, [companyInfo.sector]);
    const byYear = new Map();
    for (const r of peerRows) {
      if (!byYear.has(r.fiscal_year)) byYear.set(r.fiscal_year, []);
      byYear.get(r.fiscal_year).push(r);
    }
    sectorPercentileTrend = [...byYear.entries()]
      .filter(([, peers]) => peers.some(p => p.symbol === cleanSym))
      .map(([year, peers]) => {
        const self = peers.find(p => p.symbol === cleanSym);
        const n = peers.length;
        if (n < 4) return null; // same MIN_PEERS floor as the frontend's percentileRank
        const worseCount = peers.filter(p => p.symbol !== cleanSym && p.pe_ratio > self.pe_ratio).length;
        return { fiscalYear: year, percentile: Math.round((worseCount / (n - 1)) * 100), peerCount: n };
      })
      .filter(Boolean)
      .sort((a, b) => a.fiscalYear - b.fiscalYear);
  }

  // N. Shareholding pattern (current snapshot + last disclosed change only --
  // see shareholding_current's own comment in initDB for why no history table).
  const shareholding = await getShareholding(cleanSym);

  const analysisResult = {
    symbol: cleanSym,
    fullName: companyInfo?.name || cleanSym,
    // Unknown sector/category stays null rather than defaulting to a specific
    // guess ('Equities'/'A') -- that would present an unverified classification
    // as if it were the company's real, confirmed sector/category.
    sector: companyInfo?.sector || null,
    category: companyInfo?.category || null,
    currentPrice,
    closeDate: latestRow.date,
    ath: {
      price: athPrice > 0 ? athPrice : currentPrice,
      date: athDate,
      drawdownPercent: currentDrawdownFromATH
    },
    atl: {
      price: atlPrice < Infinity ? atlPrice : currentPrice,
      date: atlDate,
      risePercent: currentRiseFromATL
    },
    maxDrawdown: {
      percent: Number(maxDrawdown.toFixed(2)),
      peakDate: mddPeakDate,
      troughDate: mddTroughDate
    },
    technical: {
      sma50,
      sma200,
      trendSignal
    },
    valuationCorridor: {
      currentPe,
      medianPe,
      p25Pe,
      p75Pe,
      pePercentileRank,
      status: pePercentileRank !== null
        ? (pePercentileRank <= 25 ? 'Deep Historical Discount (<25th Percentile)' : pePercentileRank <= 75 ? 'Fair Historical Range (25th–75th Percentile)' : 'Elevated Multiple (>75th Percentile)')
        : 'P/E multiple unrated'
    },
    meanReversion: {
      historicalMedianPe: medianPe,
      targetPrice: meanReversionTargetPrice,
      impliedUpside: meanReversionUpside
    },
    grahamAndBuffett: {
      eps,
      navps,
      grahamNumber,
      marginOfSafety,
      earningsYield,
      bondSpread
    },
    // Matches StockModal.jsx's "Audited Financial Disclosures" section 1:1
    // (added 2026-08-23) so the deep-dive page can render the same block
    // without a second request or re-deriving these from raw fundamentals.
    disclosures: {
      auditedPe,
      eps,
      navps,
      paidUpCapital,
      marketCap,
      dividendYield
    },
    catalysts: macroCatalysts,
    cycles: historicalCycles,
    timeline,
    financialStatements,
    riskMetrics,
    returnsTable,
    fundamentalsGrowth,
    week52,
    liquidity,
    sectorPercentileTrend,
    shareholding
  };

  // Cache in memory for 5 minutes
  analysisCache.set(cleanSym, { timestamp: Date.now(), data: analysisResult });

  return analysisResult;
}

// 10. Fetch 20-Year Annual Fundamentals History
// No internal try/catch swallowing a real DB error to [] here (fixed
// 2026-08-23) -- that made a genuine SQL failure indistinguishable from a
// symbol that legitimately has zero statements on file, both from this
// function's own return value. The caller (GET /api/fundamentals-history/:symbol)
// now does the right thing with each case (500 vs. 200 empty) -- but only if
// a real error actually reaches it instead of being silently converted here.
export async function getCompanyFundamentalsHistory(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return [];
  return await dbAll(`
    SELECT fiscal_year as year, period, eps_basic as eps, nav_per_share as navps,
           roe, dividend_yield as dividendYield, dps, pe_ratio as pe, debt_to_equity as debtToEquity,
           current_ratio as currentRatio, paid_up_capital_mn as paidUpCapital, audit_status as auditStatus
    FROM fundamentals_history
    WHERE symbol = ?
    ORDER BY fiscal_year DESC
  `, [cleanSym]);
}

// 11. Screener Flags -- per-symbol booleans computed across a company's full
// fundamentals_history record, for the main screener's quick-filter chips
// (Dividend Aristocrats / Turnaround Candidates). Neither is derivable from
// today's live /api/stocks snapshot (that's current-year only), so this is
// a small standalone bulk query rather than something bolted onto the
// already-large getAllStocksFromDB. ~1,900 rows total across all symbols --
// cheap enough to compute fresh per request, no caching needed.
export async function getScreenerFlags() {
  const rows = await dbAll(`
    SELECT symbol, fiscal_year, eps_basic as eps, dps
    FROM fundamentals_history
    ORDER BY symbol, fiscal_year ASC
  `);

  const bySymbol = new Map();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }

  const flags = {};
  for (const [symbol, yrs] of bySymbol.entries()) {
    // Dividend Aristocrat: DPS never decreased year over year, across at
    // least 3 disclosed years with a real dps value (fewer than that isn't
    // a meaningful "track record" claim either way).
    const dpsYears = yrs.filter(y => y.dps !== null && y.dps !== undefined);
    let dividendAristocrat = false;
    if (dpsYears.length >= 3) {
      dividendAristocrat = true;
      for (let i = 1; i < dpsYears.length; i++) {
        if (Number(dpsYears[i].dps) < Number(dpsYears[i - 1].dps)) { dividendAristocrat = false; break; }
      }
    }

    // Turnaround: most recent disclosed year is profitable, the one right
    // before it was a loss (or breakeven) -- a real profit/loss sign flip
    // between two adjacent real disclosures, not just "eps grew".
    let turnaround = false;
    if (yrs.length >= 2) {
      const latest = yrs[yrs.length - 1];
      const prior = yrs[yrs.length - 2];
      if (latest.eps !== null && latest.eps !== undefined && prior.eps !== null && prior.eps !== undefined) {
        turnaround = Number(latest.eps) > 0 && Number(prior.eps) <= 0;
      }
    }

    if (dividendAristocrat || turnaround) {
      flags[symbol] = { dividendAristocrat, turnaround };
    }
  }
  return flags;
}

// 12. Sector Performance -- this symbol's price return over a window vs. the
// equal-weighted average return of its own sector peers over the same
// window, computed directly from price_history (no per-peer client-side
// fetching -- one bounded query over just this sector's symbols). `days`
// null means the full archive (matches the frontend's 'ALL' range option).
export async function getSectorPerformance(symbol, days) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return null;

  const company = await dbGet(`SELECT sector FROM company_list WHERE symbol = ?`, [cleanSym]);
  if (!company || !company.sector) return null;
  const sector = company.sector;

  const sectorRows = await dbAll(`SELECT symbol FROM company_list WHERE sector = ?`, [sector]);
  const sectorSymbols = sectorRows.map(r => r.symbol);
  if (sectorSymbols.length === 0) return null;
  const placeholders = sectorSymbols.map(() => '?').join(',');

  const latestRows = await dbAll(`
    SELECT ph.symbol, ph.close
    FROM price_history ph
    INNER JOIN (
      SELECT symbol, MAX(date) as max_date FROM price_history
      WHERE symbol IN (${placeholders}) AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
      GROUP BY symbol
    ) m ON ph.symbol = m.symbol AND ph.date = m.max_date
  `, sectorSymbols);

  let cutoffRows;
  if (days === null) {
    // Full archive: earliest row per symbol.
    cutoffRows = await dbAll(`
      SELECT ph.symbol, ph.close
      FROM price_history ph
      INNER JOIN (
        SELECT symbol, MIN(date) as min_date FROM price_history
        WHERE symbol IN (${placeholders}) AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
        GROUP BY symbol
      ) m ON ph.symbol = m.symbol AND ph.date = m.min_date
    `, sectorSymbols);
  } else {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    cutoffRows = await dbAll(`
      SELECT ph.symbol, ph.close
      FROM price_history ph
      INNER JOIN (
        SELECT symbol, MAX(date) as cutoff_date FROM price_history
        WHERE symbol IN (${placeholders}) AND date <= ? AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
        GROUP BY symbol
      ) m ON ph.symbol = m.symbol AND ph.date = m.cutoff_date
    `, [...sectorSymbols, cutoffStr]);
  }

  const latestMap = new Map(latestRows.map(r => [r.symbol, Number(r.close)]));
  const cutoffMap = new Map(cutoffRows.map(r => [r.symbol, Number(r.close)]));

  const returns = {};
  for (const sym of sectorSymbols) {
    const latest = latestMap.get(sym);
    const cutoff = cutoffMap.get(sym);
    if (latest !== undefined && cutoff !== undefined && cutoff > 0) {
      returns[sym] = Number((((latest - cutoff) / cutoff) * 100).toFixed(2));
    }
  }

  const stockReturn = returns[cleanSym] ?? null;
  const peerReturns = Object.entries(returns).filter(([sym]) => sym !== cleanSym).map(([, v]) => v);
  const sectorAvgReturn = peerReturns.length > 0
    ? Number((peerReturns.reduce((a, b) => a + b, 0) / peerReturns.length).toFixed(2))
    : null;

  return { symbol: cleanSym, sector, stockReturn, sectorAvgReturn, peerCount: peerReturns.length };
}
