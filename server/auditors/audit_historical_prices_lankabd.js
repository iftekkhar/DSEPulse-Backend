/**
 * Independent external audit: cross-checks price_history (main DB, data/dse.db
 * -- the standalone staging DB this file's header used to reference was
 * retired 2026-08-29, see ARCHITECTURE.md) against lankabd.com's live
 * PriceArchive, a third-party financial portal with its own
 * independently-maintained record.
 *
 * This is deliberately kept separate from the internal institutional audit
 * (server/auditors/audit_main_database.js), which only checks internal
 * consistency of our own stored data. This tool checks our data against an
 * outside source.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAll, dbRun } from '../db.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { fetchWithRetry } from '../../shared/dse_http_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://lankabd.com/',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Column indices confirmed against LankaBD PriceArchive table structure
const COL = {
  DATE: 0,
  LTP: 2,
  HIGH: 3,
  LOW: 4,
  OPEN: 5,
  CLOSE: 6,
  YCP: 7,
  CHANGE_PCT: 8,
  TRADE: 13,
  VALUE_MN: 14,
  VOLUME: 15,
  MCAP_BN: 23
};

export function parseRows(html, symbol) {
  const tbodyStart = html.indexOf('<tbody');
  const tbodyEnd = html.indexOf('</tbody>');
  if (tbodyStart === -1) return [];
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRegex.exec(tbody)) !== null) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, '').trim().replace(/,/g, ''));
    if (cells.length < 16) continue;
    const rawDate = cells[COL.DATE];
    const dm = rawDate.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!dm) continue;
    const trade_date = `${dm[1]}-${dm[2]}-${dm[3]}`;

    const open = parseFloat(cells[COL.OPEN]) || null;
    const high = parseFloat(cells[COL.HIGH]) || null;
    const low = parseFloat(cells[COL.LOW]) || null;
    const close = parseFloat(cells[COL.CLOSE]) || null;
    const ycp = parseFloat(cells[COL.YCP]) || null;
    const volume = parseInt(cells[COL.VOLUME]) || null;
    const value_mn = parseFloat(cells[COL.VALUE_MN]) || null;
    const trades = parseInt(cells[COL.TRADE]) || null;
    const mcap_bn = cells.length > COL.MCAP_BN ? parseFloat(cells[COL.MCAP_BN]) : null;
    const market_cap_mn = (mcap_bn !== null && !isNaN(mcap_bn)) ? Number((mcap_bn * 1000).toFixed(2)) : null;

    if (close === null || close <= 0) continue;

    const change_amt = (close !== null && ycp !== null && ycp > 0) ? Number((close - ycp).toFixed(2)) : null;
    const change_pct = (close !== null && ycp !== null && ycp > 0) ? Number((((close - ycp) / ycp) * 100).toFixed(2)) : null;

    rows.push({
      symbol,
      trade_date,
      date: trade_date,
      open,
      high,
      low,
      close,
      ycp,
      change: change_amt,
      change_percent: change_pct,
      volume,
      value_mn,
      market_cap_mn,
      trades,
      source: 'LANKABD'
    });
  }
  return rows;
}

export async function fetchSymbolArchive(symbol, fromDate, toDate, cookieHeader) {
  const url = `https://lankabd.com/Home/PriceArchive?symbol=${encodeURIComponent(symbol)}&fromdate=${fromDate}&todate=${toDate}`;
  // fetchWithRetry instead of a raw one-shot axios.get -- a transient failure
  // here previously meant giving up on that symbol immediately rather than
  // retrying, unlike the DSE-targeting auditors in this same directory.
  const res = await fetchWithRetry(url, { headers: { ...headers, Cookie: cookieHeader }, timeout: 90000, attempts: 3, backoffMs: 3000 });
  return parseRows(res.data, symbol);
}

/**
 * Cross-checks real daily price history for `symbols` against lankabd.com across all price_history fields.
 */
export async function runExternalCrossCheck({ symbols = ['GP', 'BATBC', 'SQURPHARMA', 'WALTONHIL', 'BRACBANK'], fromDate = '2015-01-01', tolerance = 0.05, samplesPerYear = 0 } = {}) {
  if (!isScraperEnabled('auditor.external_crosscheck_lankabd')) {
    console.log(scraperBlockedMessage('auditor.external_crosscheck_lankabd'));
    return { blocked: true };
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.log(`\n========================================================================`);
  console.log(`   EXTERNAL AUDIT: FULL SCHEMA CROSS-CHECK AGAINST LANKABD.COM`);
  console.log(`   Scope: ${symbols.length} symbols (${symbols.join(', ')}), ${fromDate} -> ${yesterday}`);
  console.log(`   Tolerance: ৳${tolerance} on closing price`);
  console.log(`========================================================================\n`);

  console.log('[1/3] Establishing session with lankabd.com...');
  // Previously this had no try/catch -- if lankabd.com was unreachable on this
  // very first request, the whole process crashed uncaught before checking a
  // single symbol or writing any audit_reports row. Now degrades to a logged
  // error report instead.
  let homeRes;
  try {
    homeRes = await fetchWithRetry('https://lankabd.com/', { headers, timeout: 20000, attempts: 3, backoffMs: 2000 });
  } catch (err) {
    console.error('[LankaBD Cross-Check] Session establishment failed:', err.message);
    try {
      await dbRun(`
        INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        new Date().toISOString(),
        'EXTERNAL_CROSSCHECK_LANKABD',
        0, 1, 0,
        'AUDIT_FAILED',
        JSON.stringify({ error: `Session establishment failed: ${err.message}` }),
      ]);
    } catch (dbErr) {
      console.error('[LankaBD Cross-Check] Also failed to save the failure report:', dbErr.message);
    }
    return { passed: false, error: err.message };
  }
  const cookieHeader = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const allComparisons = [];
  const mismatches = [];
  const incomparableRows = [];
  const yearlySampleRows = new Map(); // year -> [rows]
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
    console.log(`  -> ${lankaRows.length} sessions parsed from lankabd.com`);

    const dbRows = await dbAll(
      `SELECT symbol, date as trade_date, open, high, low, close, ycp, change, change_percent, volume, value_mn, source
       FROM price_history
       WHERE symbol = ? AND date >= ? AND date <= ?
       ORDER BY date ASC`,
      [symbol, fromDate, yesterday]
    );
    const dbMap = new Map(dbRows.map(r => [r.trade_date, r]));
    const lankaMap = new Map(lankaRows.map(r => [r.trade_date, r]));

    for (const [date, lankaRow] of lankaMap.entries()) {
      const dbRow = dbMap.get(date);
      if (!dbRow) { missingInDb++; continue; }

      if (dbRow.close === null || lankaRow.close === null) {
        incomparable++;
        incomparableRows.push({ symbol, date, db_close: dbRow.close, lanka_close: lankaRow.close });
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

      // Collect yearly sample rows
      const yr = date.slice(0, 4);
      if (!yearlySampleRows.has(yr)) yearlySampleRows.set(yr, []);
      const yrArr = yearlySampleRows.get(yr);
      if (yrArr.length < (samplesPerYear || 20)) {
        yrArr.push({
          symbol,
          date,
          open: dbRow.open,
          high: dbRow.high,
          low: dbRow.low,
          close: dbRow.close,
          ycp: dbRow.ycp,
          change: dbRow.change,
          change_pct: dbRow.change_percent,
          volume: dbRow.volume,
          value_mn: dbRow.value_mn,
          db_source: dbRow.source,
          lanka_close: lankaRow.close,
          lanka_ycp: lankaRow.ycp,
          lanka_volume: lankaRow.volume,
          lanka_value_mn: lankaRow.value_mn,
          match: diff <= tolerance ? '✅ MATCH' : '❌ DIFF'
        });
      }
    }
    for (const date of dbMap.keys()) {
      if (!lankaMap.has(date)) missingInLanka++;
    }

    allComparisons.push({ symbol, lankaCount: lankaRows.length, dbCount: dbRows.length });
    await sleep(1500);
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

  console.log('\n========================================================================');
  console.log('   EXTERNAL CROSS-CHECK SUMMARY (vs lankabd.com)');
  console.log('========================================================================');
  console.log(JSON.stringify(summary, null, 2));

  // Display Yearly Samples
  if (yearlySampleRows.size > 0) {
    console.log('\n========================================================================');
    console.log(`   FULL-ROW YEARLY SAMPLE VERIFICATION (${yearlySampleRows.size} Years Audited)`);
    console.log('========================================================================');
    for (const [yr, rows] of [...yearlySampleRows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`\n📅 YEAR ${yr} — Sample ${rows.length} Full Rows:`);
      console.table(rows.slice(0, 20));
    }
  }

  // Persist full mismatch list to CSV
  const csvPath = path.join(__dirname, '..', '..', 'data', 'external_crosscheck_mismatches.csv');
  const csvLines = ['symbol,date,db_close,lanka_close,diff,diff_pct,db_source'];
  for (const m of mismatches) {
    csvLines.push(`${m.symbol},${m.date},${m.db_close},${m.lanka_close},${m.diff},${m.diff_pct},${m.db_source}`);
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`\nFull mismatch list written to: ${csvPath}`);

  // Log into audit_reports
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_LANKABD',
    totalCompared,
    mismatches.length,
    missingInDb + missingInLanka,
    mismatches.length === 0 ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED',
    JSON.stringify({ summary, yearlySampleCount: yearlySampleRows.size }),
  ]);

  return { summary, mismatches, allComparisons, yearlySampleRows: Object.fromEntries(yearlySampleRows), passed: mismatches.length === 0 };
}

// Previously this had no .then()/process.exit() at all -- the CLI invocation
// always exited 0 regardless of outcome, making it useless for any script or
// CI step that checks $? for pass/fail.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const symbolsArg = args.find(a => a.startsWith('--symbols='))?.split('=')[1]?.split(',') || ['GP', 'BATBC', 'SQURPHARMA', 'BRACBANK'];
  const samplesArg = parseInt(args.find(a => a.startsWith('--samples='))?.split('=')[1] || '20');
  runExternalCrossCheck({ symbols: symbolsArg, samplesPerYear: samplesArg })
    .then(res => {
      if (!res.passed) process.exit(1);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
