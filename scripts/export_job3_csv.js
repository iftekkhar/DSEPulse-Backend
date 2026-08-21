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

  // 1. Export company_fundamentals (Master Baseline)
  const masterCsvPath = path.join(DATA_DIR, 'job3_company_fundamentals_master.csv');
  console.log('▶ Exporting company_fundamentals (Master Baseline Snapshot)...');

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(masterCsvPath, { encoding: 'utf8' });
    stream.write('Symbol,Company_Name,Sector,Category,EPS_Basic,EPS_Diluted,NAV_Per_Share,Paid_Up_Capital_MN,Authorized_Capital_MN,Dividend_Yield,PE_Basic,PE_Trailing,Debt_To_Equity,Current_Ratio,Audited_Period,Quarterly_Disclosure,Last_Updated\n');

    db.all(
      `SELECT symbol, name, sector, category, eps_basic, eps_diluted, nav_per_share, 
              paid_up_capital_mn, authorized_capital_mn, dividend_yield, pe_basic, pe_trailing, 
              debt_to_equity, current_ratio, audited_period, quarterly_disclosure, updated_at
       FROM company_fundamentals 
       ORDER BY symbol ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        for (const r of rows) {
          const cleanName = (r.name || '').replace(/"/g, '""');
          stream.write(`${r.symbol},"${cleanName}",${r.sector ?? ''},${r.category ?? ''},${r.eps_basic ?? ''},${r.eps_diluted ?? ''},${r.nav_per_share ?? ''},${r.paid_up_capital_mn ?? ''},${r.authorized_capital_mn ?? ''},${r.dividend_yield ?? ''},${r.pe_basic ?? ''},${r.pe_trailing ?? ''},${r.debt_to_equity ?? ''},${r.current_ratio ?? ''},"${r.audited_period ?? ''}","${r.quarterly_disclosure ?? ''}",${r.updated_at ?? ''}\n`);
        }
        stream.end(() => {
          console.log(`✅ Exported ${rows.length.toLocaleString()} company fundamentals master records to:`);
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
          stream.write(`${r.symbol},${r.fiscal_year},"${r.period ?? ''}",${r.eps_basic ?? ''},${r.eps_diluted ?? ''},${r.nav_per_share ?? ''},${r.roe ?? ''},${r.dividend_yield ?? ''},${r.paid_up_capital_mn ?? ''},${r.authorized_capital_mn ?? ''},${r.pe_ratio ?? ''},${r.debt_to_equity ?? ''},${r.current_ratio ?? ''},${r.audit_status ?? 'Audited'},${r.recorded_at ?? ''}\n`);
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
  console.log(`2. company_fundamentals:      ${(masterStat.size / 1024).toFixed(2)} KB -> data/job3_company_fundamentals_master.csv\n`);

  process.exit(0);
}

exportJob3CSV().catch(console.error);
