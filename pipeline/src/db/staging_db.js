import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
fs.ensureDirSync(DATA_DIR);
const STAGING_DB_PATH = path.join(DATA_DIR, 'staging.db');

let dbInstance = null;

export function getStagingDB() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(STAGING_DB_PATH, (err) => {
      if (err) {
        console.error('[STAGING DB ERROR] Could not connect to staging database:', err.message);
      } else {
        dbInstance.run('PRAGMA journal_mode = WAL;');
        dbInstance.run('PRAGMA synchronous = NORMAL;');
        dbInstance.run('PRAGMA cache_size = -64000;'); // 64MB cache for large imports
        dbInstance.run('PRAGMA temp_store = MEMORY;');
      }
    });
  }
  return dbInstance;
}

export function dbRun(sql, params = []) {
  const db = getStagingDB();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function dbGet(sql, params = []) {
  const db = getStagingDB();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function dbAll(sql, params = []) {
  const db = getStagingDB();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Run multiple statements in a single transaction (fast bulk inserts)
 */
export function dbTransaction(statements) {
  const db = getStagingDB();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      let error = null;
      for (const { sql, params } of statements) {
        if (error) break;
        db.run(sql, params || [], (err) => { if (err) error = err; });
      }
      db.run(error ? 'ROLLBACK' : 'COMMIT', (err) => {
        if (error || err) reject(error || err);
        else resolve();
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEMA INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

export async function initStagingDB() {
  // ── Table 1: Canonical Active Company List ─────────────────────────────────
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_company_list (
      symbol            TEXT PRIMARY KEY,
      name              TEXT,
      sector            TEXT,
      category          TEXT,      -- A, B, N, Z, SME, Bond, MF
      listing_date      TEXT,
      face_value        REAL DEFAULT 10.0,
      total_shares      INTEGER,
      market_cap_mn     REAL,
      is_active         INTEGER DEFAULT 1,  -- 1 = currently listed on DSE today
      fetched_at        TEXT NOT NULL
    )
  `);

  // ── Table 2: Full OHLCV Price History (1999–Yesterday) ────────────────────
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_price_history (
      symbol            TEXT NOT NULL,
      trade_date        TEXT NOT NULL,   -- YYYY-MM-DD
      open              REAL,
      high              REAL,
      low               REAL,
      close             REAL NOT NULL,
      volume            INTEGER,
      value_mn          REAL,            -- Turnover (million BDT); NULL if not in source
      trades            INTEGER,
      ycp               REAL,            -- Yesterday's closing price (if available)
      change_amt        REAL,
      change_pct        REAL,
      source            TEXT NOT NULL,   -- 'MENDELEY', 'DSE_SCRAPE', 'DERIVED'
      staged_at         TEXT NOT NULL,
      PRIMARY KEY (symbol, trade_date)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_price_symbol ON stg_price_history (symbol)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_price_date   ON stg_price_history (trade_date)`);

  // ── Table 3: Merged Index History (DGEN 1999-2012 + DSEX 2013-Today) ───────
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_index_history (
      trade_date        TEXT PRIMARY KEY,  -- YYYY-MM-DD
      index_label       TEXT NOT NULL,     -- 'DGEN' | 'DSEX'
      index_value       REAL NOT NULL,     -- Raw value from source
      index_open        REAL,
      index_high        REAL,
      index_low         REAL,
      total_volume      INTEGER,
      total_value_mn    REAL,
      market_cap_bn     REAL,
      advancing         INTEGER,
      declining         INTEGER,
      unchanged         INTEGER,
      source            TEXT NOT NULL,     -- 'MENDELEY', 'KAGGLE', 'DSE_SCRAPE'
      staged_at         TEXT NOT NULL
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_index_date ON stg_index_history (trade_date)`);

  // ── Table 4: Annual Fundamentals — OFFICIAL/AUDITED ONLY ──────────────────
  // Only populated from officially disclosed data on dsebd.org company pages.
  // NEVER populated with synthetic/estimated values.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_annual_fundamentals (
      symbol            TEXT NOT NULL,
      fiscal_year       INTEGER NOT NULL,  -- e.g. 2024 = FY ending June 2024
      eps               REAL,              -- Basic EPS (BDT) — from audited P&L
      navps             REAL,              -- Net Asset Value Per Share (BDT) — audited B/S
      dps               REAL,              -- Cash Dividend Per Share (BDT) declared
      bonus_pct         REAL,              -- Bonus share % (e.g. 10 = 10%)
      rights_ratio      TEXT,              -- Rights share ratio (e.g. "1R:5")
      paid_up_capital_mn REAL,             -- Paid-up capital in million BDT
      total_shares      INTEGER,           -- Total issued shares outstanding
      year_end_close    REAL,              -- Closing price on last session of fiscal year
      pe_ratio          REAL,              -- Derived: year_end_close / eps
      pb_ratio          REAL,              -- Derived: year_end_close / navps
      roe               REAL,              -- Derived: eps / navps * 100
      dividend_yield    REAL,              -- Derived: dps / year_end_close * 100
      market_cap_mn     REAL,              -- Derived: year_end_close * total_shares / 1e6
      disclosure_date   TEXT,              -- Date the disclosure was published on DSE
      source            TEXT NOT NULL,     -- 'DSE_OFFICIAL' only — no synthetic values
      staged_at         TEXT NOT NULL,
      PRIMARY KEY (symbol, fiscal_year)
    )
  `);

  // Technical indicators and performance summaries are computed on demand
  // (see analytics_engine.js's getSymbolAnalytics), not pre-computed/stored here --
  // there was no promotion destination for them in the main DB either (it already
  // computes on the fly), so a persisted table just risked silent staleness for
  // no benefit. stg_computed_analytics / stg_performance_summary were dropped.

  // ── Table 6: Audit Certification Logs ────────────────────────────────────
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
    )
  `);

  console.log(`[STAGING DB] Pipeline Staging Database initialized: ${STAGING_DB_PATH}`);
  console.log(`[STAGING DB] Tables: stg_company_list, stg_price_history, stg_index_history,`);
  console.log(`[STAGING DB]         stg_annual_fundamentals, audit_reports`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WRITE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a batch of price records into stg_price_history.
 * Batches into transactions of 500 for performance.
 */
export async function stagePriceBatch(records = []) {
  const now = new Date().toISOString();
  const BATCH_SIZE = 500;
  let count = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const stmts = batch
      .filter(r => r.symbol && r.trade_date && r.close != null && r.close > 0)
      .map(r => ({
        sql: `INSERT INTO stg_price_history
          (symbol, trade_date, open, high, low, close, volume, value_mn, trades, ycp, change_amt, change_pct, source, staged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, trade_date) DO UPDATE SET
            open=excluded.open, high=excluded.high, low=excluded.low,
            close=excluded.close, volume=excluded.volume,
            value_mn=excluded.value_mn, ycp=excluded.ycp,
            change_amt=excluded.change_amt, change_pct=excluded.change_pct,
            source=excluded.source, staged_at=excluded.staged_at`,
        params: [
          r.symbol.toUpperCase().trim(),
          r.trade_date,
          r.open != null ? Number(r.open) : null,
          r.high != null ? Number(r.high) : null,
          r.low  != null ? Number(r.low)  : null,
          Number(r.close),
          r.volume != null ? parseInt(r.volume) : null,
          r.value_mn != null ? Number(r.value_mn) : null,
          r.trades != null ? parseInt(r.trades) : null,
          r.ycp != null ? Number(r.ycp) : null,
          r.change_amt != null ? Number(r.change_amt) : null,
          r.change_pct != null ? Number(r.change_pct) : null,
          r.source || 'UNKNOWN',
          now,
        ]
      }));

    await dbTransaction(stmts);
    count += stmts.length;
  }
  return count;
}

/**
 * Upsert index history records into stg_index_history.
 */
export async function stageIndexBatch(records = []) {
  const now = new Date().toISOString();
  const BATCH_SIZE = 500;
  let count = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const stmts = batch
      .filter(r => r.trade_date && r.index_value > 0)
      .map(r => ({
        sql: `INSERT INTO stg_index_history
          (trade_date, index_label, index_value, index_open, index_high, index_low, total_volume, total_value_mn, source, staged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trade_date) DO UPDATE SET
            index_value=excluded.index_value, index_open=excluded.index_open,
            index_high=excluded.index_high, index_low=excluded.index_low,
            total_volume=excluded.total_volume, source=excluded.source, staged_at=excluded.staged_at`,
        params: [
          r.trade_date,
          r.index_label || 'DSEX',
          Number(r.index_value),
          r.index_open != null ? Number(r.index_open) : null,
          r.index_high != null ? Number(r.index_high) : null,
          r.index_low  != null ? Number(r.index_low)  : null,
          r.total_volume != null ? parseInt(r.total_volume) : null,
          r.total_value_mn != null ? Number(r.total_value_mn) : null,
          r.source || 'UNKNOWN',
          now,
        ]
      }));

    await dbTransaction(stmts);
    count += stmts.length;
  }
  return count;
}

/**
 * Upsert company fundamentals — OFFICIAL AUDITED DATA ONLY.
 * Source must always be 'DSE_OFFICIAL'.
 */
export async function stageFundamental(record) {
  const now = new Date().toISOString();
  await dbRun(`
    INSERT INTO stg_annual_fundamentals
      (symbol, fiscal_year, eps, navps, dps, bonus_pct, rights_ratio,
       paid_up_capital_mn, total_shares, year_end_close,
       pe_ratio, pb_ratio, roe, dividend_yield, market_cap_mn,
       disclosure_date, source, staged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DSE_OFFICIAL', ?)
    ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
      eps=excluded.eps, navps=excluded.navps, dps=excluded.dps,
      bonus_pct=excluded.bonus_pct, rights_ratio=excluded.rights_ratio,
      paid_up_capital_mn=excluded.paid_up_capital_mn,
      total_shares=excluded.total_shares, year_end_close=excluded.year_end_close,
      pe_ratio=excluded.pe_ratio, pb_ratio=excluded.pb_ratio,
      roe=excluded.roe, dividend_yield=excluded.dividend_yield,
      market_cap_mn=excluded.market_cap_mn,
      disclosure_date=excluded.disclosure_date, staged_at=excluded.staged_at
  `, [
    record.symbol.toUpperCase().trim(),
    record.fiscal_year,
    record.eps ?? null,
    record.navps ?? null,
    record.dps ?? null,
    record.bonus_pct ?? null,
    record.rights_ratio ?? null,
    record.paid_up_capital_mn ?? null,
    record.total_shares ?? null,
    record.year_end_close ?? null,
    record.pe_ratio ?? null,
    record.pb_ratio ?? null,
    record.roe ?? null,
    record.dividend_yield ?? null,
    record.market_cap_mn ?? null,
    record.disclosure_date ?? null,
    now,
  ]);
}

