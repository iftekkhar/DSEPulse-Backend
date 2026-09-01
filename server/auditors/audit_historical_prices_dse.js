/**
 * Live cross-check audit for stg_price_history against DSE itself (the Tier 1
 * source), complementing external_crosscheck_lankabd.js (which checks against
 * Tier 2 LankaBangla). Together the two give price_history a live check
 * against both real sources, not just internal range validation.
 *
 * Uses the single "All Instrument" day_end_archive.php request (confirmed
 * elsewhere in this pipeline to cover every symbol in one call) for a recent
 * trailing window -- a full 2015-2026 per-symbol re-fetch for 639 symbols
 * would be hours of requests for a check whose main job is catching drift in
 * the data most likely to have just changed. Widen `days` for a deeper check.
 */
import * as cheerio from 'cheerio';
import { dbAll, dbRun } from '../db.js';
import { fetchWithRetry } from '../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { numOrNull } from '../../shared/safe_number.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runDSEPriceCrossCheck({ days = 30, tolerance = 0.05 } = {}) {
  if (!isScraperEnabled('auditor.external_crosscheck_dse_prices')) {
    console.log(scraperBlockedMessage('auditor.external_crosscheck_dse_prices'));
    return { blocked: true };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start = new Date();
  start.setDate(start.getDate() - days);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = yesterday.toISOString().slice(0, 10);

  console.log(`\n[DSE Price Cross-Check] Fetching ${days}-day All-Instrument archive from DSE: ${startStr} -> ${endStr}...`);
  const url = `https://www.dsebd.org/day_end_archive.php?startDate=${startStr}&endDate=${endStr}&inst=${encodeURIComponent('All Instrument')}&archive=data`;
  // Previously this fetch had no try/catch -- exhausting fetchWithRetry's 3
  // attempts threw uncaught, crashing the whole process before an audit_reports
  // row could be written for the failed run. Now degrades to a logged error
  // report instead.
  let res;
  try {
    res = await fetchWithRetry(url, { timeout: 60000, attempts: 3, backoffMs: 3000 });
  } catch (err) {
    console.error('[DSE Price Cross-Check] Live fetch failed:', err.message);
    try {
      await dbRun(`
        INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        new Date().toISOString(),
        'EXTERNAL_CROSSCHECK_DSE_PRICES',
        0, 1, 0,
        'AUDIT_FAILED',
        JSON.stringify({ error: `Live fetch failed: ${err.message}` }),
      ]);
    } catch (dbErr) {
      console.error('[DSE Price Cross-Check] Also failed to save the failure report:', dbErr.message);
    }
    return { passed: false, error: err.message };
  }
  const $ = cheerio.load(res.data);

  const liveRows = new Map(); // "SYMBOL|DATE" -> {close, ycp, volume}
  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const c = $(row).find('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim().replace(/,/g, '')).get();
      if (c.length < 12) return;
      const dateRaw = c[1];
      if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return;
      const symbol = c[2].toUpperCase().trim();
      if (!symbol) return;
      const close = numOrNull(c[7]) ?? numOrNull(c[3]);
      const ycp = numOrNull(c[8]);
      const volume = numOrNull(c[11]);
      liveRows.set(`${symbol}|${dateRaw}`, { close, ycp, volume });
    });
  });
  console.log(`[DSE Price Cross-Check] Parsed ${liveRows.size} live (symbol,date) sessions from DSE.`);

  const dbRows = await dbAll('SELECT symbol, date as trade_date, close, ycp, volume, source FROM price_history WHERE date >= ?', [startStr]);

  const mismatches = [];
  let compared = 0;
  let missingInDb = 0;
  for (const [key, liveRow] of liveRows.entries()) {
    const [symbol, date] = key.split('|');
    const dbRow = dbRows.find(r => r.symbol === symbol && r.trade_date === date);
    if (!dbRow) { missingInDb++; continue; }
    if (liveRow.close === null || dbRow.close === null) continue;
    compared++;
    const diff = Math.abs(liveRow.close - dbRow.close);
    if (diff > tolerance) {
      mismatches.push({ symbol, date, db_close: dbRow.close, dse_close: liveRow.close, diff: Number(diff.toFixed(4)), db_source: dbRow.source });
    }
  }
  const dbKeySet = new Set(dbRows.map(r => `${r.symbol}|${r.trade_date}`));
  const missingLive = [...dbKeySet].filter(k => !liveRows.has(k)).length;

  const summary = {
    windowDays: days,
    liveSessionsParsed: liveRows.size,
    compared,
    totalMismatches: mismatches.length,
    mismatchRate: compared ? Number(((mismatches.length / compared) * 100).toFixed(3)) : 0,
    missingInDb,    // DSE has it, we don't -- a real gap
    missingLive,    // we have it (e.g. from LankaBD), DSE's recent window doesn't -- expected for Tier 2-only dates
  };

  console.log('\n======================================================');
  console.log('   DSE PRICE HISTORY LIVE CROSS-CHECK SUMMARY');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));

  const csvPath = path.join(__dirname, '..', '..', 'data', 'dse_price_crosscheck_mismatches.csv');
  const lines = ['symbol,date,db_close,dse_close,diff,db_source'];
  for (const m of mismatches) lines.push(`${m.symbol},${m.date},${m.db_close},${m.dse_close},${m.diff},${m.db_source}`);
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nFull mismatch list written to: ${csvPath}`);

  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_DSE_PRICES',
    compared,
    mismatches.length,
    missingInDb,
    mismatches.length === 0 ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED',
    JSON.stringify(summary),
  ]);

  return { summary, mismatches, passed: mismatches.length === 0 };
}

// Previously this had no .then()/process.exit() at all -- the CLI invocation
// always exited 0 regardless of outcome (passed, failed, or blocked/disabled),
// making it useless for any script or CI step that checks $? for pass/fail.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDSEPriceCrossCheck()
    .then(res => {
      if (!res.passed) process.exit(1);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
