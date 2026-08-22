import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { numOrNull } from '../shared/safe_number.js';

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

  await dbRun(`
    CREATE TABLE IF NOT EXISTS company_fundamentals (
      symbol TEXT PRIMARY KEY,
      name TEXT,
      sector TEXT,
      category TEXT,
      eps_basic REAL,
      eps_diluted REAL,
      eps_quarterly REAL,
      nav_per_share REAL,
      paid_up_capital_mn REAL,
      authorized_capital_mn REAL,
      pe_basic REAL,
      pe_diluted REAL,
      pe_trailing REAL,
      dividend_yield REAL,
      debt_to_equity REAL,
      current_ratio REAL,
      audited_period TEXT,
      quarterly_disclosure TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  try { await dbRun(`ALTER TABLE company_fundamentals ADD COLUMN debt_to_equity REAL;`); } catch { /* column exists */ }
  try { await dbRun(`ALTER TABLE company_fundamentals ADD COLUMN current_ratio REAL;`); } catch { /* column exists */ }

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

  await dbRun(`
    CREATE TABLE IF NOT EXISTS intraday_breadth_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_time TEXT,
      advancing INTEGER,
      declining INTEGER,
      unchanged INTEGER,
      total_trades INTEGER,
      total_volume INTEGER,
      total_value_mn REAL,
      dsex_index REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

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

  await dbRun(`DELETE FROM price_history WHERE date LIKE '%T%' OR date LIKE '%:%'`).catch(() => {});
}

// 1. High-Speed Bulk Daily Market Closing Batch Ingestion
export async function saveDailyClosingToDB(records, dateStr) {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  if (!isSqliteAvailable || !db) return 0;
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  let count = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, close, ycp, change, change_percent, volume, pe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        pe = excluded.pe
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
      const ycp = r.ycp !== null && r.ycp !== undefined ? Number(r.ycp) : null;
      const change = r.change !== null && r.change !== undefined
        ? Number(r.change)
        : (ycp !== null && ycp > 0 ? Number((close - ycp).toFixed(2)) : null);
      const change_percent = r.changePercent !== null && r.changePercent !== undefined
        ? Number(r.changePercent)
        : (ycp !== null && ycp > 0 ? Number((((close - ycp) / ycp) * 100).toFixed(2)) : null);
      const volume = r.volume !== null && r.volume !== undefined ? Number(r.volume) : null;
      const pe = r.pe !== null && r.pe !== undefined ? Number(r.pe) : null;

      stmt.run([symbol, targetDate, close, ycp, change, change_percent, volume, pe]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
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

  let count = 0;
  await dbRun('BEGIN TRANSACTION');
  try {
    const stmt = dbPrepare(`
      INSERT INTO price_history (symbol, date, close, ycp, change, change_percent, volume, pe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        close = excluded.close,
        ycp = excluded.ycp,
        change = excluded.change,
        change_percent = excluded.change_percent,
        volume = excluded.volume,
        pe = excluded.pe
    `);

    for (const r of records) {
      const date = r.date;
      // null (not 0) when neither alias is present -- see saveDailyClosingToDB
      // above for why this must skip on missing data rather than fall through a
      // fabricated 0 into the close <= 0 guard.
      const closeRaw = r.close ?? r.ltp ?? null;
      const close = closeRaw !== null ? Number(closeRaw) : null;
      if (!date || close === null || close <= 0) continue;

      // Defaulting ycp to `close` when missing silently forces change/changePercent
      // to compute as exactly 0 (close - close) -- fabricating "no price movement"
      // for a day whose real prior close simply wasn't provided. Preserve null
      // throughout instead: these mean different things, and collapsing "unknown"
      // into "known zero" is exactly the kind of silent fabrication this project's
      // sourcing policy exists to prevent.
      const ycp = r.ycp !== null && r.ycp !== undefined ? Number(r.ycp) : null;
      const change = r.change !== null && r.change !== undefined
        ? Number(r.change)
        : (ycp !== null && ycp > 0 ? Number((close - ycp).toFixed(2)) : null);
      const change_percent = r.changePercent !== null && r.changePercent !== undefined
        ? Number(r.changePercent)
        : (ycp !== null && ycp > 0 ? Number((((close - ycp) / ycp) * 100).toFixed(2)) : null);
      const volume = r.volume !== null && r.volume !== undefined ? Number(r.volume) : null;
      const pe = r.pe !== null && r.pe !== undefined ? Number(r.pe) : null;

      stmt.run([cleanSym, date, close, ycp, change, change_percent, volume, pe]);
      count++;
    }

    await new Promise((res, rej) => stmt.finalize(err => err ? rej(err) : res()));
    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK');
    throw err;
  }
  return count;
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


// 4. Save Single Company Fundamentals to SQLite
// Fields that describe one specific audited fiscal period as a coherent set (EPS,
// NAVPS, P/E, dividend yield, debt/equity, current ratio). Previously each column was
// upserted independently via COALESCE(new, existing) -- so a write carrying a fresh
// EPS for a new fiscal year but no NAVPS (because that particular scrape/endpoint
// didn't have it) would silently leave the OLD period's NAVPS in place, blending two
// different years into one "current" row (e.g. FY2025 EPS paired with FY2020 NAVPS --
// produced ROE readings above 10,000%). Now: when the incoming record's audited_period
// genuinely differs from what's stored, these fields are replaced atomically as a set
// (including going to NULL for one the new disclosure doesn't report), instead of
// preserving stale values from a different period. `IS NOT` is used for the period
// comparison because it's null-safe in SQLite (unlike `!=`), so a first-ever period
// value is also treated as "different" and triggers the atomic replace.
const PERIOD_COUPLED_SET_CLAUSE = `
      eps_basic = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.eps_basic ELSE COALESCE(excluded.eps_basic, company_fundamentals.eps_basic) END,
      eps_diluted = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.eps_diluted ELSE COALESCE(excluded.eps_diluted, company_fundamentals.eps_diluted) END,
      eps_quarterly = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.eps_quarterly ELSE COALESCE(excluded.eps_quarterly, company_fundamentals.eps_quarterly) END,
      nav_per_share = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.nav_per_share ELSE COALESCE(excluded.nav_per_share, company_fundamentals.nav_per_share) END,
      pe_basic = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.pe_basic ELSE COALESCE(excluded.pe_basic, company_fundamentals.pe_basic) END,
      pe_diluted = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.pe_diluted ELSE COALESCE(excluded.pe_diluted, company_fundamentals.pe_diluted) END,
      pe_trailing = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.pe_trailing ELSE COALESCE(excluded.pe_trailing, company_fundamentals.pe_trailing) END,
      dividend_yield = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.dividend_yield ELSE COALESCE(excluded.dividend_yield, company_fundamentals.dividend_yield) END,
      debt_to_equity = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.debt_to_equity ELSE COALESCE(excluded.debt_to_equity, company_fundamentals.debt_to_equity) END,
      current_ratio = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.current_ratio ELSE COALESCE(excluded.current_ratio, company_fundamentals.current_ratio) END,
      quarterly_disclosure = CASE WHEN excluded.audited_period IS NOT NULL AND excluded.audited_period IS NOT company_fundamentals.audited_period THEN excluded.quarterly_disclosure ELSE COALESCE(excluded.quarterly_disclosure, company_fundamentals.quarterly_disclosure) END,
      audited_period = COALESCE(excluded.audited_period, company_fundamentals.audited_period)`;

// Null-safe change detection for saveFundamentalsBulkDelta's smart-delta skip
// logic: a plain `Number(oldVal) !== Number(newVal)` coerces null to 0, so
// "known -> genuinely unknown" and "known -> 0" become indistinguishable.
function valueChanged(oldVal, newVal) {
  if (oldVal === null && newVal === null) return false;
  if (oldVal === null || newVal === null) return true;
  return Number(oldVal) !== Number(newVal);
}

export async function saveFundamentals(data) {
  if (!data || !data.symbol) return;
  const symbol = data.symbol.toUpperCase().trim();

  await dbRun(`
    INSERT INTO company_fundamentals (
      symbol, name, sector, category, eps_basic, eps_diluted, eps_quarterly,
      nav_per_share, paid_up_capital_mn, authorized_capital_mn,
      pe_basic, pe_diluted, pe_trailing, dividend_yield, debt_to_equity, current_ratio,
      audited_period, quarterly_disclosure, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      name = COALESCE(excluded.name, company_fundamentals.name),
      sector = COALESCE(excluded.sector, company_fundamentals.sector),
      category = COALESCE(excluded.category, company_fundamentals.category),
      paid_up_capital_mn = COALESCE(excluded.paid_up_capital_mn, company_fundamentals.paid_up_capital_mn),
      authorized_capital_mn = COALESCE(excluded.authorized_capital_mn, company_fundamentals.authorized_capital_mn),
      ${PERIOD_COUPLED_SET_CLAUSE},
      updated_at = datetime('now')
  `, [
    symbol,
    data.name || null,
    data.sector || null,
    data.category || null,
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
    data.auditedPeriod || null,
    data.quarterlyDisclosure || null
  ]);
}

// 4b. O(1) In-Memory Smart Delta Bulk Fundamentals Ingestion (0 writes if unchanged)
export async function saveFundamentalsBulkDelta(records) {
  if (!records || !Array.isArray(records) || records.length === 0) {
    return { total: 0, changedCount: 0, unchangedCount: 0, changedSymbols: [] };
  }
  if (!isSqliteAvailable || !db) {
    return { total: records.length, changedCount: 0, unchangedCount: records.length, changedSymbols: [] };
  }

  // 1. Fetch current snapshot in 1 single fast query
  const existingRows = await dbAll(`
    SELECT symbol, name, sector, category, eps_basic, eps_diluted, eps_quarterly,
           nav_per_share, paid_up_capital_mn, authorized_capital_mn,
           pe_basic, pe_diluted, pe_trailing, dividend_yield, debt_to_equity, current_ratio,
           audited_period, quarterly_disclosure
    FROM company_fundamentals
  `);

  const existingMap = new Map();
  for (const row of existingRows) {
    existingMap.set(row.symbol.toUpperCase().trim(), row);
  }

  const toUpdate = [];
  const changedSymbols = [];

  for (const r of records) {
    if (!r || !r.symbol) continue;
    const sym = String(r.symbol).toUpperCase().trim();
    const existing = existingMap.get(sym);

    if (!existing) {
      toUpdate.push(r);
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
    const periodChanged = existing.audited_period !== periodNew;
    const debtChanged = valueChanged(existing.debt_to_equity, debtNew);
    const crChanged = valueChanged(existing.current_ratio, crNew);

    if (epsChanged || navChanged || paidUpChanged || periodChanged || debtChanged || crChanged) {
      toUpdate.push(r);
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
      INSERT INTO company_fundamentals (
        symbol, name, sector, category, eps_basic, eps_diluted, eps_quarterly,
        nav_per_share, paid_up_capital_mn, authorized_capital_mn,
        pe_basic, pe_diluted, pe_trailing, dividend_yield, debt_to_equity, current_ratio,
        audited_period, quarterly_disclosure, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET
        name = COALESCE(excluded.name, company_fundamentals.name),
        sector = COALESCE(excluded.sector, company_fundamentals.sector),
        category = COALESCE(excluded.category, company_fundamentals.category),
        paid_up_capital_mn = COALESCE(excluded.paid_up_capital_mn, company_fundamentals.paid_up_capital_mn),
        authorized_capital_mn = COALESCE(excluded.authorized_capital_mn, company_fundamentals.authorized_capital_mn),
        ${PERIOD_COUPLED_SET_CLAUSE},
        updated_at = datetime('now')
    `);

    for (const data of toUpdate) {
      const symbol = String(data.symbol).toUpperCase().trim();
      stmt.run([
        symbol,
        data.name || null,
        data.sector || null,
        data.category || null,
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
        data.auditedPeriod || null,
        data.quarterlyDisclosure || null
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

// 4c. Single Smart Delta Upsert helper
export async function saveFundamentalsDelta(data) {
  const res = await saveFundamentalsBulkDelta([data]);
  return { changed: res.changedCount > 0, symbol: data.symbol };
}

// 5. Get All Fundamentals map
export async function getAllFundamentalsMap() {
  const rows = await dbAll('SELECT * FROM company_fundamentals');
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
      peBasic: r.pe_basic,
      peDiluted: r.pe_diluted,
      peTrailing: r.pe_trailing,
      dividendYield: r.dividend_yield,
      debtToEquity: r.debt_to_equity,
      currentRatio: r.current_ratio,
      auditedPeriod: r.audited_period,
      quarterlyDisclosure: r.quarterly_disclosure,
      updatedAt: r.updated_at
    };
  }
  return map;
}

// 5a. Save Market Breadth & Sector Summary to SQLite
// 5a. Save Intraday Breadth Snapshot (Dedicated for Job 4 - replaced every 30 mins)
export async function saveIntradayBreadthSnapshot(data) {
  if (!data) return;
  const nowDhaka = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

  await dbRun(`
    INSERT OR REPLACE INTO intraday_breadth_snapshot (
      id, slot_time, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, dsex_index, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    nowDhaka,
    // null (not 0) when the scrape didn't return a field -- 0 would assert
    // "confirmed zero" for something that's actually just unknown.
    data.advancing ?? null,
    data.declining ?? null,
    data.unchanged ?? null,
    data.totalTrades ?? null,
    data.totalVolume ?? null,
    data.totalValueMn ?? null,
    data.dsexIndex ?? null
  ]);
}

// 5b. Get Latest Intraday Breadth Snapshot from SQLite
export async function getIntradayBreadthSnapshot() {
  return await dbGet(`SELECT * FROM intraday_breadth_snapshot WHERE id = 1`);
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

  await dbRun(`
    INSERT INTO dsex_market_history (
      date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      dsex_index = excluded.dsex_index,
      advancing = excluded.advancing,
      declining = excluded.declining,
      unchanged = excluded.unchanged,
      total_trades = excluded.total_trades,
      total_volume = excluded.total_volume,
      total_value_mn = excluded.total_value_mn
  `, [
    targetDate,
    dsexIndex,
    data.advancing ?? null,
    data.declining ?? null,
    data.unchanged ?? null,
    data.totalTrades ?? null,
    data.totalVolume ?? null,
    data.totalValueMn ?? null
  ]);
}

// 5d. Get 20-Year DSEX Historical Timeline
export async function getDSEXHistoricalTimeline(limit = 7500) {
  // No auto-seed fallback here: if there's real data, return it; if there's not
  // (or not much), that's the honest answer -- never top it up with fabricated rows.
  let rows = await dbAll(`
    SELECT date, dsex_index as dsexIndex, advancing, declining, unchanged, total_value_mn as turnoverMn, total_volume as volume
    FROM dsex_market_history
    ORDER BY date ASC
    LIMIT ?
  `, [limit]);

  return rows || [];
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
          f.audited_period as auditedPeriod,
          f.quarterly_disclosure as quarterlyDisclosure,
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
        FROM company_fundamentals f
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

      const marketCap = (ltp !== null && paidUpCapital !== null)
        ? Number(((paidUpCapital / 10) * ltp).toFixed(2))
        : null;

      const auditedPeriod = r.auditedPeriod || null;

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
    SELECT date, close as ltp, ycp, change, change_percent as changePercent, volume, pe
    FROM price_history
    WHERE symbol = ? AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
    ORDER BY date ASC
  `, [cleanSym]);

  // 2. Fetch fundamentals
  const fund = await dbGet(`
    SELECT * FROM company_fundamentals WHERE symbol = ?
  `, [cleanSym]);

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
  const eps = fund?.eps_basic !== null && fund?.eps_basic !== undefined ? Number(fund.eps_basic) : null;
  const navps = fund?.nav_per_share !== null && fund?.nav_per_share !== undefined ? Number(fund.nav_per_share) : null;
  const currentPe = (currentPrice > 0 && eps && eps > 0) ? Number((currentPrice / eps).toFixed(2)) : (latestRow.pe || null);

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
    volume: r.volume !== null && r.volume !== undefined ? Number(r.volume) : null,
    pe: r.pe !== null ? Number(r.pe) : null,
    dsex: dsexMap.get(r.date) || null
  }));

  // Fetch 20-Year Financial Statements safely
  let financialStatements = [];
  try {
    financialStatements = await dbAll(`
      SELECT fiscal_year as year, period, eps_basic as eps, nav_per_share as navps, 
             roe, dividend_yield as dividendYield, pe_ratio as pe, debt_to_equity as debtToEquity, 
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

  const analysisResult = {
    symbol: cleanSym,
    fullName: fund?.name || cleanSym,
    // Unknown sector/category stays null rather than defaulting to a specific
    // guess ('Equities'/'A') -- that would present an unverified classification
    // as if it were the company's real, confirmed sector/category.
    sector: fund?.sector || null,
    category: fund?.category || null,
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
    catalysts: macroCatalysts,
    cycles: historicalCycles,
    timeline,
    financialStatements
  };

  // Cache in memory for 5 minutes
  analysisCache.set(cleanSym, { timestamp: Date.now(), data: analysisResult });

  return analysisResult;
}

// 10. Fetch 20-Year Annual Fundamentals History
export async function getCompanyFundamentalsHistory(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return [];
  try {
    return await dbAll(`
      SELECT fiscal_year as year, period, eps_basic as eps, nav_per_share as navps, 
             roe, dividend_yield as dividendYield, pe_ratio as pe, debt_to_equity as debtToEquity, 
             current_ratio as currentRatio, paid_up_capital_mn as paidUpCapital, audit_status as auditStatus
      FROM fundamentals_history
      WHERE symbol = ?
      ORDER BY fiscal_year DESC
    `, [cleanSym]);
  } catch {
    return [];
  }
}
