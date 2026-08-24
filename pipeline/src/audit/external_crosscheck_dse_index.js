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
import { initStagingDB, dbAll, dbRun } from '../db/staging_db.js';
import { fetchWithRetry } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runDSEIndexCrossCheck({ tolerance = 0.05 } = {}) {
  if (!isScraperEnabled('pipeline.external_crosscheck_dse_index')) {
    console.log(scraperBlockedMessage('pipeline.external_crosscheck_dse_index'));
    return { blocked: true };
  }
  await initStagingDB();

  console.log('\n[DSE Index Cross-Check] Fetching recent official DSEX sessions from DSE...');
  const res = await fetchWithRetry('https://www.dsebd.org/recent_market_information.php', { timeout: 20000, attempts: 3, backoffMs: 2000 });
  const $ = cheerio.load(res.data);
  const live = new Map();
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length >= 6 && /\d{2}-\d{2}-\d{4}/.test(cells[0])) {
      const [d, m, y] = cells[0].split('-');
      const dsex = parseFloat(cells[5]);
      if (!isNaN(dsex) && dsex > 1000) live.set(`${y}-${m}-${d}`, dsex);
    }
  });
  console.log(`[DSE Index Cross-Check] Reachable live window: ${live.size} sessions.`);

  const tier1Rows = await dbAll(`
    SELECT trade_date, index_value, source FROM stg_index_history
    WHERE source IN ('DSE_OFFICIAL_ARCHIVE', 'DSE_OFFICIAL_BENCHMARK')
    ORDER BY trade_date ASC
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
    mismatches.length === 0 ? 'EXTERNAL_VERIFIED_CLEAN' : 'EXTERNAL_MISMATCHES_FOUND',
    JSON.stringify(summary),
  ]);

  return { summary, mismatches, unreachableTier1 };
}
