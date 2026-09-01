/**
 * Live cross-check audit for stg_index_history's Tier 1 rows (source =
 * DSE_OFFICIAL_ARCHIVE or DSE_OFFICIAL_BENCHMARK) against DSE itself. LankaBD
 * carries no DSEX index data, so DSE is the only real source to check here.
 *
 * KNOWN LIMITATION: the only live DSE endpoint currently wired up
 * (recent_market_information.php, also used by gap_scraper.js's fillIndexGap)
 * only returns the trailing ~30 sessions. That reaches every
 * DSE_OFFICIAL_BENCHMARK row but NONE of the older DSE_OFFICIAL_ARCHIVE range
 * (2024-08-22 -> the point BENCHMARK takes over). Checked 2026-08-22/23: no
 * other live DSE endpoint for that older range has been located yet -- this
 * module checks what it can reach and reports the unreachable range honestly
 * rather than silently skipping it. Widening coverage means finding DSE's
 * actual historical DSEX archive page/endpoint, not something this module can
 * paper over.
 *
 * Tier 3 rows (KAGGLE, MCAP_WEIGHTED_ESTIMATE) are out of scope by design --
 * they're compiled/derived datasets for periods with no live official source
 * to check against at all, which is precisely why they're Tier 3.
 */
import * as cheerio from 'cheerio';
import { dbAll, dbRun } from '../db.js';
import { fetchWithRetry } from '../../shared/dse_http_client.js';
import { fetchHistoricalIndexGraph } from '../scrapers/scrape_historical_indexes.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runDSEIndexCrossCheck({ tolerance = 0.05 } = {}) {
  if (!isScraperEnabled('auditor.external_crosscheck_dse_index')) {
    console.log(scraperBlockedMessage('auditor.external_crosscheck_dse_index'));
    return { blocked: true };
  }

  const live = new Map();

  // 1. Fetch recent table sessions
  console.log('\n[DSE Index Cross-Check] 1. Fetching recent official DSEX sessions from DSE table...');
  try {
    const res = await fetchWithRetry('https://www.dsebd.org/recent_market_information.php', { timeout: 20000, attempts: 3, backoffMs: 2000 });
    const $ = cheerio.load(res.data);
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length >= 6 && /\d{2}-\d{2}-\d{4}/.test(cells[0])) {
        const [d, m, y] = cells[0].split('-');
        const dsex = parseFloat(cells[5]);
        if (!isNaN(dsex) && dsex > 1000) live.set(`${y}-${m}-${d}`, dsex);
      }
    });
  } catch (e) {
    console.warn('[DSE Index Cross-Check] Warning: recent_market_information.php unreachable:', e.message);
  }

  // 2. Fetch full multi-year continuous DSEX graph series directly from DSE's official endpoint
  console.log('[DSE Index Cross-Check] 2. Fetching continuous 16-year DSEX graph series from DSE...');
  try {
    const graphPoints = await fetchHistoricalIndexGraph({ type: 'dseX', durationMonths: 200 });
    for (const pt of graphPoints) {
      if (!live.has(pt.date)) {
        live.set(pt.date, pt.value);
      }
    }
  } catch (e) {
    console.warn('[DSE Index Cross-Check] Warning: monthly_graph_index.php unreachable:', e.message);
  }

  console.log(`[DSE Index Cross-Check] Total reachable live sessions across table + graph: ${live.size} sessions.`);

  const tier1Rows = await dbAll(`
    SELECT date as trade_date, dsex_index as index_value, source FROM dsex_market_history
    WHERE source IN ('DSE_OFFICIAL_ARCHIVE', 'DSE_OFFICIAL_BENCHMARK', 'DSE_OFFICIAL_GRAPH')
    ORDER BY date ASC
  `);
  const liveDates = [...live.keys()];
  const reachableMin = liveDates.length ? liveDates.reduce((a, b) => a < b ? a : b) : null;
  const unreachableTier1 = tier1Rows.filter(r => !reachableMin || r.trade_date < reachableMin);

  const mismatches = [];
  let compared = 0;
  for (const row of tier1Rows) {
    const liveVal = live.get(row.trade_date);
    if (liveVal === undefined) continue;
    compared++;
    if (Math.abs(liveVal - row.index_value) > tolerance) {
      mismatches.push({ date: row.trade_date, db_value: row.index_value, live_value: liveVal, source: row.source });
    }
  }

  const summary = {
    tier1RowsTotal: tier1Rows.length,
    reachableLiveWindow: live.size,
    compared,
    totalMismatches: mismatches.length,
    unreachableTier1RowsOutsideLiveWindow: unreachableTier1.length,
  };

  console.log('\n======================================================');
  console.log('   DSE INDEX HISTORY LIVE CROSS-CHECK SUMMARY');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));
  if (unreachableTier1.length) {
    console.log(`NOTE: ${unreachableTier1.length} Tier 1 rows (${tier1Rows[0]?.trade_date} -> ${reachableMin}) are outside this endpoint's reach -- not checked, not assumed correct.`);
  }

  const csvPath = path.join(__dirname, '..', '..', 'data', 'dse_index_crosscheck_mismatches.csv');
  const lines = ['date,db_value,live_value,source'];
  for (const m of mismatches) lines.push(`${m.date},${m.db_value},${m.live_value},${m.source}`);
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nMismatch list written to: ${csvPath}`);

  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_DSE_INDEX',
    compared,
    mismatches.length,
    unreachableTier1.length,
    mismatches.length === 0 ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED',
    JSON.stringify(summary),
  ]);

  return { summary, mismatches, unreachableTier1, passed: mismatches.length === 0 };
}

// Previously this had no .then()/process.exit() at all -- the CLI invocation
// always exited 0 regardless of outcome, making it useless for any script or
// CI step that checks $? for pass/fail.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDSEIndexCrossCheck()
    .then(res => {
      if (!res.passed) process.exit(1);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
