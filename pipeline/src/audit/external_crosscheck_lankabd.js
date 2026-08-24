/**
 * Independent external audit: cross-checks stg_price_history (sourced from
 * Mendeley/Kaggle — "2nd tier" datasets) against lankabd.com's live PriceArchive,
 * a third-party financial portal with its own independently-maintained record.
 *
 * This is deliberately kept separate from the internal institutional audit
 * (audit_runner.js / auditor.js), which only checks internal consistency of our
 * own staged data. This tool checks our data against an outside source.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initStagingDB, dbAll, dbRun } from '../db/staging_db.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://lankabd.com/',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Column indices confirmed against BRACBANK 2023-06-01 row + thead labels
const COL = { DATE: 0, LTP: 2, HIGH: 3, LOW: 4, OPEN: 5, CLOSE: 6, YCP: 7, CHANGE_PCT: 8, TRADE: 13, VALUE_MN: 14, VOLUME: 15 };

function parseRows(html, symbol) {
  const tbodyStart = html.indexOf('<tbody');
  const tbodyEnd = html.indexOf('</tbody>');
  if (tbodyStart === -1) return [];
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRegex.exec(tbody)) !== null) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 16) continue;
    const rawDate = cells[COL.DATE];
    const dm = rawDate.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!dm) continue;
    const trade_date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    rows.push({
      symbol,
      trade_date,
      open: parseFloat(cells[COL.OPEN]) || null,
      high: parseFloat(cells[COL.HIGH]) || null,
      low: parseFloat(cells[COL.LOW]) || null,
      close: parseFloat(cells[COL.CLOSE]) || null,
      ycp: parseFloat(cells[COL.YCP]) || null,
      volume: parseInt(cells[COL.VOLUME].replace(/,/g, '')) || null,
    });
  }
  return rows;
}

async function fetchSymbolArchive(symbol, fromDate, toDate, cookieHeader) {
  const url = `https://lankabd.com/Home/PriceArchive?symbol=${encodeURIComponent(symbol)}&fromdate=${fromDate}&todate=${toDate}`;
  const res = await axios.get(url, { headers: { ...headers, Cookie: cookieHeader }, timeout: 90000 });
  return parseRows(res.data, symbol);
}

/**
 * Runs the cross-check for a given list of symbols over a date range.
 * Returns { compared, mismatches, missingInDb, missingInLanka, bySource }
 */
export async function runExternalCrossCheck({ symbols, fromDate = '2013-01-01', toDate = null, tolerance = 0.05 } = {}) {
  if (!isScraperEnabled('pipeline.external_crosscheck_lankabd')) {
    console.log(scraperBlockedMessage('pipeline.external_crosscheck_lankabd'));
    return { blocked: true };
  }
  await initStagingDB();
  const yesterday = toDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  console.log(`\n[ExternalCrossCheck] Establishing session with lankabd.com...`);
  const homeRes = await axios.get('https://lankabd.com/', { headers, timeout: 20000 });
  const cookieHeader = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const allComparisons = [];
  const mismatches = [];
  const incomparableRows = []; // {symbol, date, db_close, lanka_close} -- which side was null, for diagnosis
  let totalCompared = 0;
  let missingInDb = 0;
  let missingInLanka = 0;
  let incomparable = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`[${i + 1}/${symbols.length}] Fetching ${symbol} from lankabd.com (${fromDate} -> ${yesterday})...`);
    let lankaRows;
    try {
      lankaRows = await fetchSymbolArchive(symbol, fromDate, yesterday, cookieHeader);
    } catch (e) {
      console.error(`  ERROR fetching ${symbol}: ${e.message}`);
      await sleep(3000);
      continue;
    }
    console.log(`  -> ${lankaRows.length} sessions from lankabd.com`);

    const dbRows = await dbAll(
      'SELECT trade_date, open, high, low, close, ycp, volume, source FROM stg_price_history WHERE symbol = ? AND trade_date >= ? AND trade_date <= ?',
      [symbol, fromDate, yesterday]
    );
    const dbMap = new Map(dbRows.map(r => [r.trade_date, r]));
    const lankaMap = new Map(lankaRows.map(r => [r.trade_date, r]));

    for (const [date, lankaRow] of lankaMap.entries()) {
      const dbRow = dbMap.get(date);
      if (!dbRow) { missingInDb++; continue; }
      // Treating a missing close as 0 would compute a wildly wrong diff (e.g. a
      // real ৳55 vs an unknown-treated-as-0 close reads as a ৳55 "mismatch") --
      // can't meaningfully compare against an unknown value, so skip instead.
      if (dbRow.close === null || dbRow.close === undefined || lankaRow.close === null || lankaRow.close === undefined) {
        incomparable++;
        // Previously uncounted beyond a single aggregate number -- kept here
        // (2026-08-23) so a rare incomparable row can actually be identified
        // and inspected instead of just being a number in the summary.
        incomparableRows.push({
          symbol, date,
          db_close: dbRow.close ?? null,
          lanka_close: lankaRow.close ?? null,
        });
        continue;
      }
      totalCompared++;
      const diff = Math.abs(dbRow.close - lankaRow.close);
      const diffPct = lankaRow.close ? (diff / lankaRow.close) * 100 : 0;
      if (diff > tolerance) {
        mismatches.push({
          symbol, date,
          db_close: dbRow.close, lanka_close: lankaRow.close,
          diff: Number(diff.toFixed(4)), diff_pct: Number(diffPct.toFixed(3)),
          db_source: dbRow.source,
        });
      }
    }
    for (const date of dbMap.keys()) {
      if (!lankaMap.has(date)) missingInLanka++;
    }

    allComparisons.push({ symbol, lankaCount: lankaRows.length, dbCount: dbRows.length });
    await sleep(2000);
  }

  const bySource = {};
  for (const m of mismatches) {
    bySource[m.db_source] = (bySource[m.db_source] || 0) + 1;
  }

  const summary = {
    symbolsChecked: symbols.length,
    totalCompared,
    totalMismatches: mismatches.length,
    mismatchRate: totalCompared ? Number(((mismatches.length / totalCompared) * 100).toFixed(3)) : 0,
    missingInDb,
    missingInLanka,
    incomparable,
    mismatchesBySource: bySource,
  };

  console.log('\n======================================================');
  console.log('   EXTERNAL CROSS-CHECK SUMMARY (vs lankabd.com)');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));
  if (incomparableRows.length > 0) {
    console.log(`\nIncomparable rows (matched date, null close on one side):`);
    console.log(JSON.stringify(incomparableRows, null, 2));
  }

  // Persist full mismatch list to CSV
  const csvPath = path.join(__dirname, '..', '..', 'data', 'external_crosscheck_mismatches.csv');
  const csvLines = ['symbol,date,db_close,lanka_close,diff,diff_pct,db_source'];
  for (const m of mismatches) {
    csvLines.push(`${m.symbol},${m.date},${m.db_close},${m.lanka_close},${m.diff},${m.diff_pct},${m.db_source}`);
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`\nFull mismatch list written to: ${csvPath}`);

  // Separate small CSV for incomparable rows (2026-08-23) -- previously only
  // an aggregate count with no way to identify which row(s) it referred to.
  const incomparableCsvPath = path.join(__dirname, '..', '..', 'data', 'external_crosscheck_incomparable.csv');
  const incomparableLines = ['symbol,date,db_close,lanka_close'];
  for (const r of incomparableRows) {
    incomparableLines.push(`${r.symbol},${r.date},${r.db_close ?? ''},${r.lanka_close ?? ''}`);
  }
  fs.writeFileSync(incomparableCsvPath, incomparableLines.join('\n'));
  if (incomparableRows.length > 0) {
    console.log(`Incomparable-row list written to: ${incomparableCsvPath}`);
  }

  // Log into audit_reports as a distinct, clearly-labeled external audit entry
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_LANKABD',
    totalCompared,
    mismatches.length,
    missingInDb + missingInLanka,
    mismatches.length === 0 ? 'EXTERNAL_VERIFIED_CLEAN' : 'EXTERNAL_MISMATCHES_FOUND',
    JSON.stringify(summary),
  ]);

  return { summary, mismatches, allComparisons };
}
