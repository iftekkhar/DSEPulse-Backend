import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'dse.db');

export async function exportJob1CSV() {
  console.log('================================================================================');
  console.log('  📦 EXPORTING JOB 1 DATABASE TO CSV (CHUNKED STREAM ENGINE)');
  console.log('================================================================================\n');

  if (!fs.existsSync(DB_PATH)) {
    console.error('Database file not found at:', DB_PATH);
    return;
  }

  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

  // 1. Export dsex_market_history
  const dsexCsvPath = path.join(DATA_DIR, 'job1_dsex_market_history_20y.csv');
  console.log('▶ Exporting dsex_market_history...');

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dsexCsvPath, { encoding: 'utf8' });
    stream.write('Date,DSEX_Index,Advancing,Declining,Unchanged,Total_Trades,Total_Volume,Total_Value_MN\n');

    db.all(
      `SELECT date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn 
       FROM dsex_market_history 
       ORDER BY date ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        for (const row of rows) {
          stream.write(`${row.date},${row.dsex_index},${row.advancing},${row.declining},${row.unchanged},${row.total_trades},${row.total_volume},${row.total_value_mn}\n`);
        }
        stream.end(() => {
          console.log(`✅ Exported ${rows.length.toLocaleString()} DSEX market history rows to:`);
          console.log(`   ${dsexCsvPath}\n`);
          resolve();
        });
      }
    );
  });

  // 2. Export price_history in batches of 50,000 rows
  const priceCsvPath = path.join(DATA_DIR, 'job1_price_history_20y.csv');
  console.log('▶ Exporting price_history (825k+ records in memory-safe batches)...');

  const stream = fs.createWriteStream(priceCsvPath, { encoding: 'utf8' });
  stream.write('Symbol,Date,Open,High,Low,Close,YCP,Change,Change_Percent,Volume,Value_MN,PE\n');

  const countRow = await new Promise((res, rej) => {
    db.get('SELECT COUNT(*) as total FROM price_history', (err, row) => err ? rej(err) : res(row));
  });

  const totalRows = countRow.total;
  const batchSize = 50000;
  let offset = 0;

  while (offset < totalRows) {
    const rows = await new Promise((res, rej) => {
      db.all(
        `SELECT symbol, date, open, high, low, close, ycp, change, change_percent, volume, value_mn, pe 
         FROM price_history 
         ORDER BY symbol ASC, date ASC 
         LIMIT ? OFFSET ?`,
        [batchSize, offset],
        (err, r) => err ? rej(err) : res(r)
      );
    });

    let buffer = '';
    for (const r of rows) {
      buffer += `${r.symbol},${r.date},${r.open ?? r.ycp},${r.high ?? r.close},${r.low ?? r.close},${r.close},${r.ycp},${r.change},${r.change_percent},${r.volume},${r.value_mn ?? ''},${r.pe ?? ''}\n`;
    }

    const canContinue = stream.write(buffer);
    if (!canContinue) {
      await new Promise(r => stream.once('drain', r));
    }

    offset += rows.length;
    console.log(`   ...streamed ${offset.toLocaleString()} / ${totalRows.toLocaleString()} rows (${((offset / totalRows) * 100).toFixed(1)}%)`);
  }

  await new Promise(r => stream.end(r));
  db.close();

  const dsexStat = fs.statSync(dsexCsvPath);
  const priceStat = fs.statSync(priceCsvPath);

  console.log('\n================================================================================');
  console.log('  🎯 JOB 1 CSV EXPORT COMPLETED SUCCESSFULLY');
  console.log('================================================================================');
  console.log(`1. price_history:     ${(priceStat.size / (1024 * 1024)).toFixed(2)} MB -> data/job1_price_history_20y.csv`);
  console.log(`2. dsex_history:      ${(dsexStat.size / 1024).toFixed(2)} KB -> data/job1_dsex_market_history_20y.csv\n`);

  process.exit(0);
}

exportJob1CSV().catch(console.error);
