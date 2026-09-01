import * as cheerio from 'cheerio';
import {
  saveDailyClosingToDB,
  saveDSEXDailyClosing,
  saveDS30DailyClosing,
  getAllFundamentalsMap,
  invalidateStocksCache
} from '../../db.js';
import { fetchWithRetry } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';
import { numOrNull } from '../../../shared/safe_number.js';
import { scrapeDs30IndexLevel } from './ds30_index_scraper.js';

export async function fetchDSEClosingPrices() {
  try {
    const res = await fetchWithRetry('https://dsebd.org/dse_close_price.php', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      attempts: 3,
      backoffMs: 2000
    });

    const $ = cheerio.load(res.data);
    const records = [];
    const rows = $('table.table-bordered tr, table tr');

    rows.each((i, tr) => {
      const cols = $(tr).find('td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (cols.length >= 4) {
        const symbol = cols[1].toUpperCase().trim();
        const close = parseFloat(cols[2].replace(/,/g, ''));
        const ycp = parseFloat(cols[3].replace(/,/g, ''));
        const high = cols[4] ? parseFloat(cols[4].replace(/,/g, '')) : null;
        const low = cols[5] ? parseFloat(cols[5].replace(/,/g, '')) : null;
        const volume = cols[6] ? parseInt(cols[6].replace(/,/g, ''), 10) : null;
        const value = cols[7] ? parseFloat(cols[7].replace(/,/g, '')) : null;

        if (symbol && !isNaN(close) && close > 0) {
          const hasYcp = !isNaN(ycp) && ycp > 0;
          const change = hasYcp ? Number((close - ycp).toFixed(2)) : null;
          const changePercent = hasYcp ? Number(((change / ycp) * 100).toFixed(2)) : null;
          records.push({
            symbol,
            close,
            closePrice: close,
            ycp: hasYcp ? ycp : null,
            // dse_close_price.php doesn't publish a real "open" -- previously
            // this borrowed yesterday's close (ycp) as a stand-in, exactly the
            // field-borrowing fabrication pattern this project's Zero-
            // Fabrication Law forbids (see ARCHITECTURE.md). Currently inert
            // (saveDailyClosingToDB's INSERT has no `open` column), but stays
            // null so wiring that column in later doesn't silently fabricate it.
            open: null,
            high: !isNaN(high) ? high : null,
            low: !isNaN(low) ? low : null,
            change,
            changePercent,
            volume: !isNaN(volume) ? volume : null,
            value: !isNaN(value) ? value : null
          });
        }
      }
    });

    console.log(`[CurrentScraper/Closing] Scraped ${records.length} official closing prices from dsebd.org`);
    return records;
  } catch (err) {
    console.warn('[CurrentScraper/Closing] Error fetching closing prices:', err.message);
    return [];
  }
}

export async function fetchMarketBreadthFromDSE() {
  try {
    const res = await fetchWithRetry('https://dsebd.org/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 12000,
      attempts: 3,
      backoffMs: 1500
    });

    const $ = cheerio.load(res.data);
    const breadth = {
      advancing: null,
      declining: null,
      unchanged: null,
      totalTrades: null,
      totalVolume: null,
      totalValueMn: null,
      dsexIndex: null
    };

    // dsebd.org's homepage summary widget (as of 2026-08) renders the DSEX
    // index as one `.midrow` per index (`.m_col-1` label, `.m_col-2` value),
    // and Advanced/Declined/Unchanged (and separately Total Trade/Volume/
    // Value) as a LABEL `.midrow` immediately followed by a VALUE `.midrow`
    // with matching column position -- not inline "Label: Value" text. A
    // page-wide regex previously matched by column position only and broke
    // silently (dsexIndex/advancing/declining came back null, and
    // "unchanged" accidentally matched the Advanced count instead). This
    // parses by structure/label text instead, so it's immune to the columns
    // being reordered and to unrelated numbers appearing nearby.
    $('div.midrow').each((_, row) => {
      const $row = $(row);
      const label = $row.find('.m_col-1').text().replace(/\s+/g, ' ').trim();
      if (/^DSEX\s+Index$/i.test(label)) {
        const val = parseFloat($row.find('.m_col-2').text().replace(/,/g, '').trim());
        if (!isNaN(val)) breadth.dsexIndex = val;
      }
    });

    $('div.midrow.mt10.mol_col-wid-cus').each((_, labelRow) => {
      const $labelRow = $(labelRow);
      const labels = $labelRow.find('div').map((__, d) => $(d).text().replace(/\s+/g, ' ').trim().toLowerCase()).get();
      const $valueRow = $labelRow.next('div.midrow.mol_col-wid-cus');
      if ($valueRow.length === 0) return;
      const values = $valueRow.find('div').map((__, d) => $(d).text().replace(/\s+/g, ' ').trim()).get();

      const joined = labels.join('|');
      if (joined.includes('advanced')) {
        const [adv, dec, unch] = values.map(v => parseInt(v.replace(/,/g, ''), 10));
        breadth.advancing = !isNaN(adv) ? adv : null;
        breadth.declining = !isNaN(dec) ? dec : null;
        breadth.unchanged = !isNaN(unch) ? unch : null;
      } else if (joined.includes('total trade')) {
        const [trades, vol, valMn] = values;
        // numOrNull instead of `parseInt(...) || null`: `||` collapses a
        // genuine "0" reading to null (0 is falsy) -- the truthy-zero-nulling
        // bug shared/safe_number.js's helpers exist to prevent.
        breadth.totalTrades = numOrNull(trades);
        breadth.totalVolume = numOrNull(vol);
        breadth.totalValueMn = numOrNull(valMn);
      }
    });

    return breadth;
  } catch (err) {
    console.warn('[CurrentScraper/Closing] Breadth scrape notice:', err.message);
    return null;
  }
}

export async function runDailyClosingPricesScraper(targetDate = null, statusTracker = null) {
  if (!isScraperEnabled('server.closing_prices')) {
    console.log(scraperBlockedMessage('server.closing_prices'));
    if (statusTracker) statusTracker.status = 'Disabled (see shared/scraper_registry.js)';
    return { success: false, blocked: true };
  }
  console.log('[JOB 1] Starting Official Daily Closing Prices Ingestion...');
  if (statusTracker) statusTracker.status = 'Running';

  try {
    const records = await fetchDSEClosingPrices();
    if (records.length === 0) {
      if (statusTracker) statusTracker.status = 'No records found (Market Holiday / Off-hours)';
      return { success: false, count: 0 };
    }

    const fundamentalsMap = await getAllFundamentalsMap();
    const todayDhakaStr = targetDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

    const enrichedRecords = records.map(r => {
      const fund = fundamentalsMap[r.symbol] || {};
      const eps = fund.eps !== null && fund.eps > 0 ? Number(fund.eps) : null;
      const dailyPe = eps ? Number((r.close / eps).toFixed(2)) : (fund.peBasic ?? null);
      return {
        ...r,
        pe: dailyPe,
        date: todayDhakaStr
      };
    });

    const cleanedRecords = [];
    const auditErrors = [];
    for (const r of enrichedRecords) {
      const result = DataAuditor.auditPriceHistory(r.symbol, [r]);
      if (result.passed && result.cleaned.length > 0) {
        // auditPriceHistory's `cleaned` shape is sized for the simpler
        // live-ticker record -- it drops high/low/value, which this
        // scraper's own fetchDSEClosingPrices() genuinely scraped. The audit
        // is still the real gate (date/close validity, duplicate/outlier
        // checks); on a pass, write the original fuller record rather than
        // silently discarding fields it never had a reason to touch.
        cleanedRecords.push(r);
      } else {
        auditErrors.push(`${r.symbol}: ${result.errors.join('; ')}`);
      }
    }
    if (cleanedRecords.length === 0) {
      if (statusTracker) statusTracker.status = `Blocked by audit: all ${auditErrors.length} records failed`;
      console.error('[JOB 1] BLOCKED by audit -- 0 records passed:', auditErrors.slice(0, 10));
      return { success: false, error: 'Audit failed', errors: auditErrors };
    }
    if (auditErrors.length > 0) {
      console.warn(`[JOB 1] ${auditErrors.length} record(s) skipped by audit:`, auditErrors.slice(0, 10));
    }

    const taggedRecords = cleanedRecords.map(r => ({ ...r, source: 'DSE_LIVE_CLOSING' }));
    const savedCount = await saveDailyClosingToDB(taggedRecords, todayDhakaStr);

    let advancing = 0, declining = 0, unchanged = 0, totalVal = 0, totalVol = 0;
    for (const r of records) {
      const hasYcp = r.ycp !== null && r.ycp !== undefined;
      if (hasYcp) {
        if (r.close > r.ycp) advancing++;
        else if (r.close < r.ycp) declining++;
        else unchanged++;
      }
      totalVal += numOrNull(r.value) ?? 0;
      totalVol += numOrNull(r.volume) ?? 0;
    }

    const liveBreadth = await fetchMarketBreadthFromDSE();
    const dsexClose = liveBreadth?.dsexIndex ?? null;

    const breadthAudit = DataAuditor.auditMarketBreadthSnapshot({
      dsexIndex: dsexClose,
      advancing,
      declining,
      unchanged,
      totalTrades: liveBreadth?.totalTrades ?? null,
      totalVolume: totalVol,
      totalValueMn: totalVal,
    });
    if (!breadthAudit.passed) {
      console.error('[JOB 1] DSEX/breadth write BLOCKED by audit:', breadthAudit.errors);
    } else {
      await saveDSEXDailyClosing({
        dsexIndex: breadthAudit.cleaned.dsexIndex,
        advancing: breadthAudit.cleaned.advancing,
        declining: breadthAudit.cleaned.declining,
        unchanged: breadthAudit.cleaned.unchanged,
        totalTrades: breadthAudit.cleaned.totalTrades,
        totalVolume: totalVol,
        totalValueMn: totalVal,
        source: 'DSE_LIVE_CLOSING'
      }, todayDhakaStr);
    }

    if (isScraperEnabled('server.ds30_index')) {
      try {
        const ds30Live = await scrapeDs30IndexLevel();
        if (ds30Live) {
          const ds30Audit = DataAuditor.auditDS30Snapshot({
            ds30Index: ds30Live.ds30Index,
            prevClose: ds30Live.prevClose,
          });
          if (!ds30Audit.passed) {
            console.error('[JOB 1] DS30 index write BLOCKED by audit:', ds30Audit.errors);
          } else {
            await saveDS30DailyClosing({
              ds30Index: ds30Audit.cleaned.ds30Index,
              prevClose: ds30Audit.cleaned.prevClose,
              changePercent: ds30Audit.cleaned.changePercent,
              source: ds30Live.source,
            }, ds30Live.date);
          }
        }
      } catch (ds30Err) {
        console.error('[JOB 1] DS30 index scrape failed (non-fatal):', ds30Err.message);
      }
    }

    if (savedCount > 0) invalidateStocksCache();
    if (statusTracker) {
      statusTracker.lastRun = new Date().toISOString();
      statusTracker.status = `Completed (${savedCount} scrips & DSEX settlement saved for ${todayDhakaStr})`;
      statusTracker.recordsIngested = savedCount;
    }

    console.log(`[JOB 1 SUCCESS] Ingested ${savedCount} daily closing records & DSEX settlement into SQLite for ${todayDhakaStr}.`);
    return { success: true, count: savedCount, date: todayDhakaStr };
  } catch (err) {
    if (statusTracker) statusTracker.status = `Failed: ${err.message}`;
    console.error('[JOB 1 ERROR]', err);
    return { success: false, error: err.message };
  }
}
