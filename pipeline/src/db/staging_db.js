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
        // Enable WAL mode for high concurrency in staging
        dbInstance.run('PRAGMA journal_mode = WAL;');
        dbInstance.run('PRAGMA synchronous = NORMAL;');
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
 * Initialize Staging Database Schema
 */
export async function initStagingDB() {
  const db = getStagingDB();

  // 1. Staged Price History
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_price_history (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      ycp REAL,
      change REAL,
      change_percent REAL,
      volume INTEGER,
      pe REAL,
      staged_at TEXT NOT NULL,
      PRIMARY KEY (symbol, date)
    )
  `);

  // 2. Staged 20-Year Audited Financial Statements
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_fundamentals_history (
      symbol TEXT NOT NULL,
      fiscal_year INTEGER NOT NULL,
      period TEXT DEFAULT 'Annual',
      eps_basic REAL,
      nav_per_share REAL,
      roe REAL,
      dividend_yield REAL,
      pe_ratio REAL,
      debt_to_equity REAL,
      current_ratio REAL,
      paid_up_capital_mn REAL,
      audit_status TEXT DEFAULT 'Audited',
      staged_at TEXT NOT NULL,
      PRIMARY KEY (symbol, fiscal_year)
    )
  `);

  // 3. Staged 20-Year DSEX Market History
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_dsex_market_history (
      date TEXT PRIMARY KEY,
      dsex_index REAL NOT NULL,
      advancing INTEGER,
      declining INTEGER,
      unchanged INTEGER,
      total_value_mn REAL,
      total_volume INTEGER,
      staged_at TEXT NOT NULL
    )
  `);

  // 4. Staged Company Fundamentals
  await dbRun(`
    CREATE TABLE IF NOT EXISTS stg_company_fundamentals (
      symbol TEXT PRIMARY KEY,
      name TEXT,
      sector TEXT,
      category TEXT,
      eps_basic REAL,
      nav_per_share REAL,
      paid_up_capital_mn REAL,
      dividend_yield REAL,
      audited_period TEXT DEFAULT 'Annual',
      staged_at TEXT NOT NULL
    )
  `);

  // 5. Institutional Audit Logs Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      records_audited INTEGER NOT NULL,
      errors_count INTEGER NOT NULL,
      warnings_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      report_json TEXT
    )
  `);

  console.log(`[STAGING DB] Dedicated Pipeline Staging Database initialized: ${STAGING_DB_PATH}`);
}

/**
 * Stage Historical Price Batch
 */
export async function stagePriceHistory(symbol, records = []) {
  const cleanSym = symbol.toUpperCase().trim();
  const now = new Date().toISOString();

  let count = 0;
  for (const r of records) {
    if (r.date && (r.close !== null && r.close !== undefined)) {
      await dbRun(`
        INSERT INTO stg_price_history (symbol, date, close, ycp, change, change_percent, volume, pe, staged_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date) DO UPDATE SET
          close = excluded.close,
          ycp = excluded.ycp,
          change = excluded.change,
          change_percent = excluded.change_percent,
          volume = excluded.volume,
          pe = excluded.pe,
          staged_at = excluded.staged_at
      `, [
        cleanSym,
        r.date,
        Number(r.close ?? r.ltp ?? 0),
        Number(r.ycp ?? r.close ?? 0),
        Number(r.change || 0),
        Number(r.changePercent || 0),
        Number(r.volume || 0),
        r.pe !== null && r.pe !== undefined ? Number(r.pe) : null,
        now
      ]);
      count++;
    }
  }
  return count;
}

/**
 * Stage 20-Year Audited Financial Statements
 */
export async function stageFinancialStatements(symbol, statements = []) {
  const cleanSym = symbol.toUpperCase().trim();
  const now = new Date().toISOString();

  let count = 0;
  for (const s of statements) {
    const yr = Number(s.year || s.fiscal_year);
    if (!isNaN(yr)) {
      await dbRun(`
        INSERT INTO stg_fundamentals_history (
          symbol, fiscal_year, period, eps_basic, nav_per_share, roe,
          dividend_yield, pe_ratio, debt_to_equity, current_ratio,
          paid_up_capital_mn, audit_status, staged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
          eps_basic = excluded.eps_basic,
          nav_per_share = excluded.nav_per_share,
          roe = excluded.roe,
          dividend_yield = excluded.dividend_yield,
          pe_ratio = excluded.pe_ratio,
          debt_to_equity = excluded.debt_to_equity,
          current_ratio = excluded.current_ratio,
          paid_up_capital_mn = excluded.paid_up_capital_mn,
          audit_status = excluded.audit_status,
          staged_at = excluded.staged_at
      `, [
        cleanSym,
        yr,
        s.period || 'Annual',
        s.eps !== undefined ? Number(s.eps) : null,
        s.navps !== undefined ? Number(s.navps) : null,
        s.roe !== undefined ? Number(s.roe) : null,
        s.dividendYield !== undefined ? Number(s.dividendYield) : null,
        s.pe !== undefined ? Number(s.pe) : null,
        s.debtToEquity !== undefined ? Number(s.debtToEquity) : 0.4,
        s.currentRatio !== undefined ? Number(s.currentRatio) : 1.8,
        s.paidUpCapital !== undefined ? Number(s.paidUpCapital) : 500,
        s.auditStatus || 'Audited',
        now
      ]);
      count++;
    }
  }
  return count;
}

/**
 * Stage 20-Year DSEX Market History
 */
export async function stageDSEXHistory(records = []) {
  const now = new Date().toISOString();
  let count = 0;
  for (const r of records) {
    if (r.date && (r.dsexIndex || r.dsex_index)) {
      await dbRun(`
        INSERT INTO stg_dsex_market_history (
          date, dsex_index, advancing, declining, unchanged, total_value_mn, total_volume, staged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          dsex_index = excluded.dsex_index,
          advancing = excluded.advancing,
          declining = excluded.declining,
          unchanged = excluded.unchanged,
          total_value_mn = excluded.total_value_mn,
          total_volume = excluded.total_volume,
          staged_at = excluded.staged_at
      `, [
        r.date,
        Number(r.dsexIndex ?? r.dsex_index),
        Number(r.advancing || 0),
        Number(r.declining || 0),
        Number(r.unchanged || 0),
        Number(r.turnoverMn ?? r.total_value_mn ?? 0),
        Number(r.volume ?? r.total_volume ?? 0),
        now
      ]);
      count++;
    }
  }
  return count;
}
