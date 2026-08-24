/**
 * Live cross-check audit for stg_company_list against DSE itself -- the only
 * real source for "which instruments exist and are currently active" (there is
 * no separate company/instrument roster on LankaBangla to check against).
 *
 * Reuses the same single "All Instrument" day_end_archive.php 30-day request
 * company_list_scraper.js itself uses to determine is_active -- this module is
 * read-only, it re-fetches and diffs rather than staging anything.
 */
import * as cheerio from 'cheerio';
import { initStagingDB, dbAll, dbRun } from '../db/staging_db.js';
import { fetchWithRetry } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runDSECompanyListCrossCheck() {
  if (!isScraperEnabled('pipeline.external_crosscheck_dse_companylist')) {
    console.log(scraperBlockedMessage('pipeline.external_crosscheck_dse_companylist'));
    return { blocked: true };
  }
  await initStagingDB();

  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const startStr = monthAgo.toISOString().slice(0, 10);
  const endStr = yesterday.toISOString().slice(0, 10);

  console.log(`\n[DSE Company List Cross-Check] Fetching 30-day traded-instrument archive: ${startStr} -> ${endStr}...`);
  const url = `https://www.dsebd.org/day_end_archive.php?startDate=${startStr}&endDate=${endStr}&inst=${encodeURIComponent('All Instrument')}&archive=data`;
  const res = await fetchWithRetry(url, { timeout: 45000, attempts: 3, backoffMs: 3000 });
  const $ = cheerio.load(res.data);

  const liveSymbols = new Set();
  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const c = $(row).find('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (c.length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(c[1])) return;
      const sym = c[2].toUpperCase().trim();
      if (sym && sym.length <= 20) liveSymbols.add(sym);
    });
  });
  console.log(`[DSE Company List Cross-Check] Live 30-day traded roster: ${liveSymbols.size} symbols.`);

  const dbRows = await dbAll('SELECT symbol, is_active FROM stg_company_list');
  const dbSymbols = new Set(dbRows.map(r => r.symbol));
  const dbActiveSymbols = new Set(dbRows.filter(r => r.is_active).map(r => r.symbol));

  const liveNotInDb = [...liveSymbols].filter(s => !dbSymbols.has(s));
  const activeButNotLiveTraded = [...dbActiveSymbols].filter(s => !liveSymbols.has(s));

  const summary = {
    liveTradedCount: liveSymbols.size,
    stagedCount: dbSymbols.size,
    liveTradedMissingFromStaging: liveNotInDb.length,   // real gap -- a traded instrument we don't have at all
    stagedActiveButNotRecentlyTraded: activeButNotLiveTraded.length, // is_active may be stale
  };

  console.log('\n======================================================');
  console.log('   DSE COMPANY LIST LIVE CROSS-CHECK SUMMARY');
  console.log('======================================================');
  console.log(JSON.stringify(summary, null, 2));
  if (liveNotInDb.length) console.log('Missing from staging entirely:', liveNotInDb);
  if (activeButNotLiveTraded.length) console.log('Marked active but not in live 30-day roster:', activeButNotLiveTraded);

  const csvPath = path.join(__dirname, '..', '..', 'data', 'dse_companylist_crosscheck_mismatches.csv');
  const lines = ['symbol,issue'];
  for (const s of liveNotInDb) lines.push(`${s},missing_from_staging`);
  for (const s of activeButNotLiveTraded) lines.push(`${s},stale_active_flag`);
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nFull discrepancy list written to: ${csvPath}`);

  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'EXTERNAL_CROSSCHECK_DSE_COMPANYLIST',
    liveSymbols.size,
    liveNotInDb.length,
    activeButNotLiveTraded.length,
    (liveNotInDb.length === 0 && activeButNotLiveTraded.length === 0) ? 'EXTERNAL_VERIFIED_CLEAN' : 'EXTERNAL_MISMATCHES_FOUND',
    JSON.stringify(summary),
  ]);

  return { summary, liveNotInDb, activeButNotLiveTraded };
}
