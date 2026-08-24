import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'dse.db');

export async function exportJob3CSV() {
  console.log('================================================================================');
  console.log('  📦 EXPORTING JOB 3 DATABASE TO CSV');
  console.log('================================================================================\n');

  if (!fs.existsSync(DB_PATH)) {
    console.error('Database file not found at:', DB_PATH);
    return;
  }

  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

  // 1. Export "current" fundamentals -- company_fundamentals dropped
  // 2026-08-23 (see ARCHITECTURE.md); this is now each symbol's latest
  // fiscal_year row in fundamentals_history, joined against company_list for
  // name/sector/category.
  const masterCsvPath = path.join(DATA_DIR, 'job3_company_fundamentals_master.csv');
  console.log('▶ Exporting current fundamentals (latest fiscal_year per symbol)...');

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(masterCsvPath, { encoding: 'utf8' });
    stream.write('Symbol,Company_Name,Sector,Category,EPS_Basic,EPS_Diluted,NAV_Per_Share,Paid_Up_Capital_MN,Authorized_Capital_MN,Dividend_Yield,PE_Ratio,PE_Trailing,Debt_To_Equity,Current_Ratio,Fiscal_Year,Period,Audit_Status,Quarterly_Disclosure,Recorded_At\n');

    db.all(
      `WITH latest AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fiscal_year DESC) as rn
         FROM fundamentals_history
       )
       SELECT l.symbol, c.name, c.sector, c.category, l.eps_basic, l.eps_diluted, l.nav_per_share,
              l.paid_up_capital_mn, l.authorized_capital_mn, l.dividend_yield, l.pe_ratio, l.pe_trailing,
              l.debt_to_equity, l.current_ratio, l.fiscal_year, l.period, l.audit_status,
              l.quarterly_disclosure, l.recorded_at
       FROM latest l
       LEFT JOIN company_list c ON c.symbol = l.symbol
       WHERE l.rn = 1
       ORDER BY l.symbol ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        for (const r of rows) {
          const cleanName = (r.name || '').replace(/"/g, '""');
          stream.write(`${r.symbol},"${cleanName}",${r.sector ?? ''},${r.category ?? ''},${r.eps_basic ?? ''},${r.eps_diluted ?? ''},${r.nav_per_share ?? ''},${r.paid_up_capital_mn ?? ''},${r.authorized_capital_mn ?? ''},${r.dividend_yield ?? ''},${r.pe_ratio ?? ''},${r.pe_trailing ?? ''},${r.debt_to_equity ?? ''},${r.current_ratio ?? ''},${r.fiscal_year ?? ''},"${r.period ?? ''}",${r.audit_status ?? ''},"${r.quarterly_disclosure ?? ''}",${r.recorded_at ?? ''}\n`);
        }
        stream.end(() => {
          console.log(`✅ Exported ${rows.length.toLocaleString()} current fundamentals records to:`);
          console.log(`   ${masterCsvPath}\n`);
          resolve();
        });
      }
    );
  });

  // 2. Export fundamentals_history (20-Year Annual Statements)
  const histCsvPath = path.join(DATA_DIR, 'job3_fundamentals_history_20y.csv');
  console.log('▶ Exporting fundamentals_history (2005–2025 Audited Statements)...');

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(histCsvPath, { encoding: 'utf8' });
    stream.write('Symbol,Fiscal_Year,Period,EPS_Basic,EPS_Diluted,NAV_Per_Share,ROE_Percent,Dividend_Yield,Paid_Up_Capital_MN,Authorized_Capital_MN,PE_Ratio,Debt_To_Equity,Current_Ratio,Audit_Status,Recorded_At\n');

    db.all(
      `SELECT symbol, fiscal_year, period, eps_basic, eps_diluted, nav_per_share, 
              roe, dividend_yield, paid_up_capital_mn, authorized_capital_mn, 
              pe_ratio, debt_to_equity, current_ratio, audit_status, recorded_at
       FROM fundamentals_history 
       ORDER BY symbol ASC, fiscal_year DESC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        for (const r of rows) {
          // audit_status blanks to '' (not a defaulted 'Audited') when
          // genuinely missing -- defaulting it would assert a verification
          // claim this row never actually made, the exact thing
          // /api/ingest/fundamentals's own comment warns against ("never
          // default an unspecified audit status to 'Audited'"). In practice
          // the column has a SQL-level DEFAULT 'Audited' so this is very
          // unlikely to ever be genuinely null, but the CSV shouldn't assert
          // it either way if it somehow is.
          stream.write(`${r.symbol},${r.fiscal_year},"${r.period ?? ''}",${r.eps_basic ?? ''},${r.eps_diluted ?? ''},${r.nav_per_share ?? ''},${r.roe ?? ''},${r.dividend_yield ?? ''},${r.paid_up_capital_mn ?? ''},${r.authorized_capital_mn ?? ''},${r.pe_ratio ?? ''},${r.debt_to_equity ?? ''},${r.current_ratio ?? ''},${r.audit_status ?? ''},${r.recorded_at ?? ''}\n`);
        }
        stream.end(() => {
          console.log(`✅ Exported ${rows.length.toLocaleString()} 20-Year fundamentals history records to:`);
          console.log(`   ${histCsvPath}\n`);
          resolve();
        });
      }
    );
  });

  db.close();

  const masterStat = fs.statSync(masterCsvPath);
  const histStat = fs.statSync(histCsvPath);

  console.log('================================================================================');
  console.log('  🎯 JOB 3 CSV EXPORT COMPLETED SUCCESSFULLY');
  console.log('================================================================================');
  console.log(`1. fundamentals_history:      ${(histStat.size / 1024).toFixed(2)} KB -> data/job3_fundamentals_history_20y.csv`);
  console.log(`2. current fundamentals:      ${(masterStat.size / 1024).toFixed(2)} KB -> data/job3_company_fundamentals_master.csv\n`);

  process.exit(0);
}

exportJob3CSV().catch(console.error);
