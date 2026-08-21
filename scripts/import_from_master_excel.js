import ExcelJS from 'exceljs';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'dse.db');
const EXCEL_PATH = path.join(DATA_DIR, 'DSE_20_Year_Master_Dataset_2005_2026.xlsx');

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

export async function importExcelStreaming() {
  console.log('🚀 Fast Streaming Import from Master Excel to SQLite...');
  console.log(`📁 Source: ${EXCEL_PATH}`);
  console.log(`🗄️ Database: ${DB_PATH}`);

  // 1. Create SQLite Schema
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
      audited_period TEXT,
      quarterly_disclosure TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Optimize SQLite PRAGMAs for lightning-fast bulk import
  await dbRun('PRAGMA synchronous = OFF');
  await dbRun('PRAGMA journal_mode = MEMORY');

  const options = {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit'
  };

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(EXCEL_PATH, options);

  let priceCount = 0;
  let dirCount = 0;
  let kpiCount = 0;

  for await (const worksheetReader of workbookReader) {
    const sheetName = worksheetReader.name;
    console.log(`▶ Processing Worksheet: [${sheetName}]...`);

    if (sheetName === 'Company_Directory') {
      await dbRun('BEGIN TRANSACTION');
      const stmtDir = db.prepare(`
        INSERT INTO company_fundamentals (symbol, name, sector, category, paid_up_capital_mn, authorized_capital_mn, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(symbol) DO UPDATE SET
          name = excluded.name,
          sector = excluded.sector,
          category = excluded.category,
          paid_up_capital_mn = excluded.paid_up_capital_mn,
          authorized_capital_mn = excluded.authorized_capital_mn,
          updated_at = datetime('now')
      `);

      for await (const row of worksheetReader) {
        if (row.number === 1) continue;
        const symbol = String(row.values[1] || '').toUpperCase().trim();
        const name = String(row.values[2] || '');
        const sector = String(row.values[3] || '');
        const category = String(row.values[4] || 'A');
        const paidUp = Number(row.values[7] || 0);
        const authCap = Number(row.values[8] || 0);

        if (symbol) {
          stmtDir.run([symbol, name, sector, category, paidUp, authCap]);
          dirCount++;
        }
      }
      stmtDir.finalize();
      await dbRun('COMMIT');
      console.log(`✅ Company_Directory: Imported ${dirCount} companies.`);
    } else if (sheetName === 'Audited_Quarterly_KPIs') {
      await dbRun('BEGIN TRANSACTION');
      const stmtKpi = db.prepare(`
        UPDATE company_fundamentals SET
          eps_basic = ?,
          eps_diluted = ?,
          nav_per_share = ?,
          dividend_yield = ?,
          audited_period = ?,
          quarterly_disclosure = ?,
          updated_at = datetime('now')
        WHERE symbol = ?
      `);

      for await (const row of worksheetReader) {
        if (row.number === 1) continue;
        const symbol = String(row.values[1] || '').toUpperCase().trim();
        const year = Number(row.values[2] || 0);
        const period = String(row.values[3] || '');
        const epsBasic = Number(row.values[4] || 0);
        const epsDiluted = Number(row.values[5] || 0);
        const navps = Number(row.values[6] || 0);
        const divYield = Number(row.values[11] || 0);

        if (symbol && (year === 2026 || year === 2025)) {
          stmtKpi.run([epsBasic, epsDiluted, navps, divYield, `FY${year} ${period}`, period, symbol]);
          kpiCount++;
        }
      }
      stmtKpi.finalize();
      await dbRun('COMMIT');
      console.log(`✅ Audited_Quarterly_KPIs: Updated ${kpiCount} audited KPI records.`);
    } else if (sheetName === 'Daily_Price_History') {
      console.log('▶ Ingesting 20-Year Daily Price History records into SQLite...');
      await dbRun('BEGIN TRANSACTION');
      const stmtPrice = db.prepare(`
        INSERT INTO price_history (symbol, date, open, high, low, close, ycp, change, change_percent, volume, pe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          ycp = excluded.ycp,
          change = excluded.change,
          change_percent = excluded.change_percent,
          volume = excluded.volume,
          pe = excluded.pe
      `);

      for await (const row of worksheetReader) {
        if (row.number === 1) continue;
        const symbol = String(row.values[1] || '').toUpperCase().trim();
        const dateStr = String(row.values[2] || '').slice(0, 10);
        const open = Number(row.values[3] || 0);
        const high = Number(row.values[4] || 0);
        const low = Number(row.values[5] || 0);
        const close = Number(row.values[6] || 0);
        const ycp = Number(row.values[7] || 0);
        const change = Number(row.values[8] || 0);
        const changePercent = Number(row.values[9] || 0);
        const volume = Number(row.values[10] || 0);
        const pe = Number(row.values[11] || 0);

        if (symbol && dateStr && close > 0) {
          stmtPrice.run([symbol, dateStr, open, high, low, close, ycp, change, changePercent, volume, pe]);
          priceCount++;
        }
      }
      stmtPrice.finalize();
      await dbRun('COMMIT');
      console.log(`✅ Daily_Price_History: Imported ${priceCount} historical daily records.`);
    }
  }

  console.log('====================================================');
  console.log('🎉 20-YEAR EXCEL TO SQLITE IMPORT COMPLETE!');
  console.log('====================================================');

  db.get('SELECT COUNT(*) as total FROM price_history', (err, pRow) => {
    console.log(`📊 Total price_history records in SQLite: ${pRow?.total}`);
    db.get('SELECT COUNT(*) as total FROM company_fundamentals', (err, fRow) => {
      console.log(`🏢 Total company_fundamentals in SQLite: ${fRow?.total}`);
      process.exit(0);
    });
  });
}

importExcelStreaming().catch(e => {
  console.error('Streaming import error:', e);
  process.exit(1);
});
