/**
 * lankabd_scraper.js
 *
 * Ingests real daily price history from lankabd.com (Tier 2 -- see
 * shared/source_tiers.js) into stg_price_history, tagged source='LANKABD'.
 *
 * The original one-off script that built the ~838K existing LANKABD rows in
 * stg_price_history (pipeline/replace_mendeley_with_lankabd.js) was deleted as
 * scratch cleanup earlier this session -- it was untracked, so it isn't
 * recoverable from git history either. This is a proper, permanent replacement:
 * registered in the scraper kill-switch, audited before every write, using the
 * canonical null-handling helpers, instead of a throwaway script. The actual
 * fetch/parse mechanics (session cookie, PriceArchive endpoint, row shape) are
 * carried over from pipeline/src/audit/external_crosscheck_lankabd.js, which
 * already proved them out for read-only comparison -- this module stages real
 * rows instead of just diffing against what's already there.
 */
import axios from 'axios';
import { initStagingDB, stagePriceBatch } from '../db/staging_db.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';
import { numOrNull, deriveOrNull, roundOrNull } from '../../../shared/safe_number.js';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://lankabd.com/',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Column indices confirmed against BRACBANK 2023-06-01 row + thead labels
// (same table shape used and verified by external_crosscheck_lankabd.js).
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

    const open = numOrNull(cells[COL.OPEN]);
    const high = numOrNull(cells[COL.HIGH]);
    const low = numOrNull(cells[COL.LOW]);
    const close = numOrNull(cells[COL.CLOSE]);
    const ycp = numOrNull(cells[COL.YCP]);
    const volume = numOrNull(cells[COL.VOLUME]);
    const value_mn = numOrNull(cells[COL.VALUE_MN]);
    const trades = numOrNull(cells[COL.TRADE]);

    if (close === null || close <= 0) continue;

    rows.push({
      symbol,
      trade_date,
      open,
      high,
      low,
      close,
      volume,
      value_mn,
      trades,
      ycp,
      // Exact arithmetic from two real values, never a fabricated fallback --
      // same rule as everywhere else in this project (see ARCHITECTURE.md).
      change_amt: deriveOrNull(close, ycp, (c, y) => y > 0 ? roundOrNull(c - y) : null),
      change_pct: deriveOrNull(close, ycp, (c, y) => y > 0 ? roundOrNull(((c - y) / y) * 100) : null),
      source: 'LANKABD',
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
 * Stages real daily price history for `symbols` from lankabd.com. Sequential,
 * not batched -- unlike DSE, lankabd.com is a single third-party session
 * behind one cookie, and the existing proven pattern (external_crosscheck)
 * already rate-limits it this way; concurrent requests risk invalidating that
 * session rather than just being impolite.
 */
export async function fillFromLankaBD({ symbols, fromDate = '2013-01-01', toDate = null } = {}) {
  if (!isScraperEnabled('pipeline.lankabd_scraper')) {
    console.log(scraperBlockedMessage('pipeline.lankabd_scraper'));
    return { staged: 0, blocked: true };
  }
  if (!symbols || symbols.length === 0) {
    console.log('[LankaBD] No symbols provided -- nothing to do.');
    return { staged: 0 };
  }
  await initStagingDB();
  const yesterday = toDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  console.log(`\n[LankaBD] Establishing session with lankabd.com...`);
  const homeRes = await axios.get('https://lankabd.com/', { headers, timeout: 20000 });
  const cookieHeader = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  let totalStaged = 0;
  let totalBlocked = 0;
  let symbolsWithData = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`[${i + 1}/${symbols.length}] Fetching ${symbol} from lankabd.com (${fromDate} -> ${yesterday})...`);
    let rows;
    try {
      rows = await fetchSymbolArchive(symbol, fromDate, yesterday, cookieHeader);
    } catch (e) {
      console.error(`  ERROR fetching ${symbol}: ${e.message}`);
      await sleep(3000);
      continue;
    }

    if (rows.length === 0) {
      console.log(`  -> 0 sessions (no real data for this instrument on lankabd.com)`);
      await sleep(1500);
      continue;
    }

    // Audit gate before stagePriceBatch -- same pattern as gap_scraper.js.
    // auditPriceHistory's `cleaned` drops open/high/low/value_mn/trades (shaped
    // for the simpler live-ticker record), so on a pass, stage the ORIGINAL
    // full-field rows for whichever dates survived, not `cleaned` itself.
    const audit = DataAuditor.auditPriceHistory(symbol, rows);
    if (!audit.passed) {
      console.error(`  BLOCKED by audit:`, audit.errors);
      totalBlocked++;
      await sleep(1500);
      continue;
    }
    const survivingDates = new Set(audit.cleaned.map(c => c.date));
    const toStage = rows.filter(r => survivingDates.has(r.trade_date));

    const n = await stagePriceBatch(toStage);
    totalStaged += n;
    symbolsWithData++;
    console.log(`  -> ${n} real sessions staged`);

    await sleep(2000);
  }

  console.log('\n======================================================');
  console.log(`[LankaBD] Complete: ${totalStaged} sessions staged across ${symbolsWithData}/${symbols.length} symbols. ${totalBlocked} symbol(s) blocked by audit.`);
  console.log('======================================================\n');

  return { staged: totalStaged, symbolsWithData, totalBlocked };
}
