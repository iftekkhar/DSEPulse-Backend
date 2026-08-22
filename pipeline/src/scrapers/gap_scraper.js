/**
 * gap_scraper.js
 *
 * Fills the price data gap between Mendeley dataset cutoff (2025-04-08)
 * and yesterday, for all active symbols. Also fills the DSEX index benchmark
 * gap from real official sessions only (no synthetic estimates).
 *
 * Source: https://www.dsebd.org/day_end_archive.php (per-symbol OHLCV)
 *         https://www.dsebd.org/recent_market_information.php (recent official DSEX)
 * Concurrency: batches of 6, 250ms between batches (see shared/dse_http_client.js)
 */

import * as cheerio from 'cheerio';
import { initStagingDB, stagePriceBatch, stageIndexBatch, dbGet, dbAll } from '../db/staging_db.js';
import { loadActiveSymbols } from './company_list_scraper.js';
import { invalidateSymbolAnalyticsCache } from '../builders/analytics_engine.js';
import { fetchWithRetry, runBatched } from '../../../shared/dse_http_client.js';

const MENDELEY_CUTOFF = '2025-04-08'; // Mendeley dataset ends here
const NARROW_WINDOW_LOOKBACK_DAYS = 3; // safety margin for late-published sessions

/**
 * Returns yesterday's date in YYYY-MM-DD format.
 */
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Scrape historical OHLCV for a symbol from dsebd.org.
 * The `Action=28` endpoint returns the company's full price history in a table.
 */
async function scrapeSymbolHistory(symbol, startDate = MENDELEY_CUTOFF, endDate = null) {
  const end = endDate || getYesterday();
  const url = `https://www.dsebd.org/day_end_archive.php?startDate=${startDate}&endDate=${end}&inst=${encodeURIComponent(symbol)}&archive=day_end`;
  let html;

  try {
    const res = await fetchWithRetry(url, { timeout: 30000, attempts: 3, backoffMs: 2000 });
    html = res.data;
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const records = [];

  $('table').each((_, table) => {
    const text = $(table).text();
    if (!text.includes('CLOSEP') && !text.includes('DATE')) return;

    $(table).find('tr').each((rowIdx, row) => {
      const cells = $(row).find('td');
      if (cells.length < 8) return;

      const cellVals = cells.toArray().map(c => $(c).text().trim().replace(/,/g, ''));

      // Expected columns: # (0) | DATE (1) | CODE (2) | LTP (3) | HIGH (4) | LOW (5) | OPENP (6) | CLOSEP (7) | YCP (8) | TRADE (9) | VALUE (10) | VOLUME (11)
      const dateRaw = cellVals[1];
      if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return;

      const high   = parseFloat(cellVals[4]) || null;
      const low    = parseFloat(cellVals[5]) || null;
      const open   = parseFloat(cellVals[6]) || null;
      const close  = parseFloat(cellVals[7]) || parseFloat(cellVals[3]) || null;
      const value  = parseFloat(cellVals[10]) || null;
      const volume = parseInt(cellVals[11]) || null;

      if (!close || close <= 0) return;

      records.push({
        symbol,
        trade_date: dateRaw,
        open,
        high,
        low,
        close,
        volume,
        value_mn: value,
        source: 'DSE_SCRAPE',
      });
    });
  });

  return records;
}

/**
 * Fill the gap: scrape active symbols for dates after their own last known price.
 *
 * Default mode (fullBackfill: false) requests a NARROW trailing window per symbol --
 * from (that symbol's own last known trade_date - a few days' safety margin) through
 * yesterday -- rather than always re-requesting the full historical range. This means
 * a routine daily run only fetches a few days per symbol once a symbol is caught up,
 * the same "today/future only" shape as the live server's Job 1. The one-time backfill
 * (through yesterday) still in progress now naturally gets a wide window per symbol
 * since most symbols' last known date is still far behind -- no separate mode needed
 * for that; the window narrows on its own as symbols catch up.
 *
 * Pass { fullBackfill: true } to force every symbol back to the full MENDELEY_CUTOFF
 * start date regardless of what's already staged -- only for a deliberate full re-scrape.
 */
export async function fillPriceGap({ symbols = null, resume = true, fullBackfill = false } = {}) {
  await initStagingDB();
  const yesterday = getYesterday();

  if (yesterday <= MENDELEY_CUTOFF) {
    console.log(`[GapScraper] No gap to fill (yesterday: ${yesterday}, Mendeley ends: ${MENDELEY_CUTOFF})`);
    return { filled: 0 };
  }

  let targetSymbols = symbols || (await loadActiveSymbols());

  // Per-symbol last known trade_date -- used both for the resume skip-check and to size
  // each symbol's narrow scrape window.
  const lastDateRows = await dbAll(`SELECT symbol, MAX(trade_date) as lastDate FROM stg_price_history GROUP BY symbol`);
  const lastDateMap = new Map(lastDateRows.map(r => [r.symbol, r.lastDate]));

  if (resume) {
    const remaining = targetSymbols.filter(s => (lastDateMap.get(s) || '') < yesterday);
    const skipped = targetSymbols.length - remaining.length;
    if (skipped > 0) {
      console.log(`[GapScraper] Resume check: ${skipped} symbols already up to date (${yesterday}), ${remaining.length} remaining to scrape.`);
    }
    targetSymbols = remaining;
  }

  console.log(`[GapScraper] Target symbols to scrape: ${targetSymbols.length} (through ${yesterday})`);
  console.log(`[GapScraper] Mode: ${fullBackfill ? `full backfill from ${MENDELEY_CUTOFF}` : 'narrow per-symbol window'}. Concurrency: batches of 6, 250ms between batches.`);

  let totalFilled = 0;
  let processed = 0;

  await runBatched(targetSymbols, async (symbol) => {
    try {
      let startDate = MENDELEY_CUTOFF;
      if (!fullBackfill) {
        const last = lastDateMap.get(symbol);
        if (last) {
          const lookback = new Date(last);
          lookback.setDate(lookback.getDate() - NARROW_WINDOW_LOOKBACK_DAYS);
          const lookbackStr = lookback.toISOString().split('T')[0];
          startDate = lookbackStr > MENDELEY_CUTOFF ? lookbackStr : MENDELEY_CUTOFF;
        }
      }

      const allRecords = await scrapeSymbolHistory(symbol, startDate);
      // Only keep records AFTER Mendeley cutoff (gap period only)
      const gapRecords = allRecords.filter(r => r.trade_date > MENDELEY_CUTOFF);
      processed++;

      if (gapRecords.length > 0) {
        const n = await stagePriceBatch(gapRecords);
        totalFilled += n;
        invalidateSymbolAnalyticsCache(symbol); // new prices landed -- don't serve stale cached analytics
        console.log(`  [${processed}/${targetSymbols.length}] ${symbol}: +${n} gap records (window: ${startDate} → ${yesterday})`);
      }
    } catch (err) {
      processed++;
      console.error(`  [${processed}/${targetSymbols.length}] ${symbol}: ERROR — ${err.message}`);
    }
  }, { batchSize: 6, delayMs: 250 });

  console.log(`\n[GapScraper] ✅ Gap fill complete: ${totalFilled} new price records added.`);
  return { filled: totalFilled };
}

/**
 * Fills the DSEX index benchmark gap between the last staged index date and yesterday.
 */
export async function fillIndexGap() {
  await initStagingDB();

  // 1. Fetch recent official DSEX from recent_market_information.php
  const officialRecent = new Map();
  try {
    const res = await fetchWithRetry('https://www.dsebd.org/recent_market_information.php', { timeout: 20000, attempts: 3, backoffMs: 2000 });
    const $ = cheerio.load(res.data);
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length >= 6 && /\d{2}-\d{2}-\d{4}/.test(cells[0])) {
        const [d, m, y] = cells[0].split('-');
        const dateStr = `${y}-${m}-${d}`;
        const dsex = parseFloat(cells[5]);
        const turnover = parseFloat(cells[3]) || null;
        const volume = parseFloat(cells[2]) || null;
        if (!isNaN(dsex) && dsex > 1000) {
          officialRecent.set(dateStr, {
            trade_date: dateStr,
            index_label: 'DSEX',
            index_value: dsex,
            turnover_mn: turnover,
            total_volume: volume,
            source: 'DSE_OFFICIAL_BENCHMARK'
          });
        }
      }
    });
    console.log(`[IndexGap] Scraped ${officialRecent.size} recent official DSEX sessions.`);
  } catch (e) {
    console.warn('[IndexGap] Failed to scrape recent market info:', e.message);
  }

  // 2. Get last DSEX in staging DB -- this is the only valid anchor; no synthetic fallback.
  const lastRow = await dbGet('SELECT trade_date, index_value FROM stg_index_history ORDER BY trade_date DESC LIMIT 1');
  if (!lastRow) {
    console.error('[IndexGap] No existing index_history rows found -- cannot anchor a gap fill. Aborting without staging anything.');
    return { filled: 0 };
  }
  const lastDate = lastRow.trade_date;
  console.log(`[IndexGap] Baseline index anchor: ${lastDate} = ${lastRow.index_value}`);

  if (officialRecent.size === 0) {
    console.log('[IndexGap] No real official DSEX sessions were scraped -- nothing to stage this run.');
    return { filled: 0 };
  }

  // 3. Get trading dates after lastDate that we might have real official data for.
  const tradingDays = await dbAll(`
    SELECT DISTINCT trade_date FROM stg_price_history WHERE trade_date > ? ORDER BY trade_date ASC
  `, [lastDate]);

  if (tradingDays.length === 0) {
    console.log(`[IndexGap] Index benchmark is already up to date (${lastDate}).`);
    return { filled: 0 };
  }

  // Only stage dates where we have a REAL scraped official value. No interpolation,
  // no synthetic estimate -- if a date has no real value, it stays a visible gap
  // rather than being silently smoothed over.
  const batch = [];
  for (const day of tradingDays) {
    const off = officialRecent.get(day.trade_date);
    if (off) batch.push(off);
  }

  if (batch.length === 0) {
    console.log('[IndexGap] None of the pending gap dates have real official DSEX data yet -- nothing staged.');
    return { filled: 0 };
  }

  const stagedCount = await stageIndexBatch(batch);
  const stillMissing = tradingDays.length - batch.length;
  console.log(`[IndexGap] ✅ Staged ${stagedCount} real official DSEX index records. ${stillMissing} date(s) still have no real data and remain ungapped.`);
  return { filled: stagedCount };
}
