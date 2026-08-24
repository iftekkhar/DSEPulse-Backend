/**
 * company_list_scraper.js
 *
 * Scrapes the full active instrument roster from dsebd.org -- equities,
 * bonds/T-bills, and mutual funds all in scope (2026-08-22 decision).
 * - Source: https://www.dsebd.org/day_end_archive.php, queried once for ALL
 *   instruments over a rolling 30-day window (not a single day's snapshot --
 *   a stock that simply didn't trade on scrape day would be silently excluded
 *   by that; verified against real DSE data on 2026-08-22 that this isn't
 *   hypothetical, it's how the archive is actually structured).
 * - is_active = 1 means "traded at least once in the last 30 days" -- a
 *   symbol absent from that window this run is marked is_active = 0.
 * - This table is the roster only: symbol/name/sector/category/face_value/
 *   total_shares/is_active. It never holds market_cap_mn or
 *   paid_up_capital_mn -- those are pricing/fundamentals-derived figures that
 *   belong exclusively to fundamentals_scraper.js (which sources the price
 *   side from stg_price_history's real year-end close), not to this scraper.
 * - Produces data/active_symbols.json for use by all other pipeline modules
 * - Detail fetches (fetchDetails: true) are resumable and batched (6 concurrent,
 *   250ms between batches) -- see shared/dse_http_client.js
 */

import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { initStagingDB, dbRun, dbAll, getStagingDB } from '../db/staging_db.js';
import { fetchWithRetry, runBatched } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';
import { numOrNull } from '../../../shared/safe_number.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SYMBOLS_FILE = path.join(DATA_DIR, 'active_symbols.json');

/**
 * Fetch every instrument (equity, bond/T-bill, or mutual fund) that traded at
 * least once in the last 30 days from DSE's day_end_archive, across ALL
 * instruments in a single request -- not a single day's snapshot (a stock
 * that simply didn't trade on scrape day would be silently excluded by that)
 * and not one request per symbol.
 * Returns a plain array of symbol strings. No price is fetched here -- market
 * cap is a pricing-derived figure and belongs entirely to
 * fundamentals_scraper.js (which already sources it from stg_price_history's
 * real year-end close, not from this scraper); this function's only job is
 * "which equities exist and are currently active."
 */
async function fetchActiveSymbolsFromDSE() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const startStr = monthAgo.toISOString().slice(0, 10);
  const endStr = yesterday.toISOString().slice(0, 10);

  const url = `https://www.dsebd.org/day_end_archive.php?startDate=${startStr}&endDate=${endStr}&inst=${encodeURIComponent('All Instrument')}&archive=data`;
  console.log(`[CompanyList] Fetching 30-day traded-instrument archive from DSE: ${startStr} -> ${endStr}`);

  let html;
  try {
    const res = await fetchWithRetry(url, { timeout: 45000, attempts: 3, backoffMs: 3000 });
    html = res.data;
  } catch (err) {
    throw new Error(`Failed to fetch 30-day archive after 3 attempts: ${err.message}`);
  }

  const $ = cheerio.load(html);
  const symbols = new Set();

  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const cellVals = $(row).find('td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (cellVals.length < 8) return;

      // Same 12-column shape as gap_scraper.js's day_end_archive parsing:
      // # (0) | DATE (1) | CODE (2) | LTP (3) | HIGH (4) | LOW (5) | OPENP (6) | CLOSEP (7) | YCP (8) | TRADE (9) | VALUE (10) | VOLUME (11)
      const dateRaw = cellVals[1];
      if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return;

      const symbol = cellVals[2].toUpperCase().trim();
      if (!symbol || symbol.length > 20) return;

      symbols.add(symbol);
    });
  });

  return Array.from(symbols);
}

/**
 * Fetch additional company details (name, sector, category) for a symbol.
 * Rate-limited to avoid blocking.
 */
async function fetchCompanyDetails(symbol) {
  const url = `https://www.dsebd.org/displayCompany.php?name=${symbol}`;
  try {
    const res = await fetchWithRetry(url, { timeout: 20000, attempts: 3, backoffMs: 2000 });
    const $ = cheerio.load(res.data);

    // No assumed face value: BDT 10 is the common case on DSE but not universal,
    // and silently defaulting to it for any company whose real value isn't found
    // on the page would misstate every downstream paid-up-capital/DPS derivation
    // that reads face_value out of stg_company_list.
    let name = null, sector = null, category = null, totalShares = null, faceValue = null;

    // Company name lives in an <h2>"Company Name: X" heading -- the page <title> is
    // the generic "Display Company Information | Dhaka Stock Exchange" on every
    // symbol's page, not company-specific (confirmed against the live page; the
    // previous title-regex approach could never have worked).
    $('h2').each((_, el) => {
      if (name) return;
      const t = $(el).text().trim();
      if (t.startsWith('Company Name:')) {
        name = t.replace(/^Company Name:\s*/i, '').trim() || null;
      }
    });

    // Parse the company info table(s). Some rows pack multiple label/value pairs into
    // one <tr> (confirmed live, e.g. ["Total No. of Outstanding Securities",
    // "92,979,912", "Sector", "IT Sector"] is a single 4-cell row) -- scan every
    // adjacent cell pair, not just cells[0]/cells[1], or labels past the first pair
    // (like Sector here) are silently missed.
    $('table tr').each((_, row) => {
      const cells = $(row).find('td, th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].toLowerCase();
        const value = cells[i + 1];
        if (!value) continue;
        if (label === 'sector') sector = value;
        else if (label.includes('category')) category = value.charAt(0).toUpperCase() || null;
        else if (label.includes('face value') || label.includes('par value')) {
          faceValue = numOrNull(value);
        } else if (label.includes('total share') || label.includes('outstanding securities')) {
          totalShares = numOrNull(value);
        }
      }
    });

    return { name, sector, category, face_value: faceValue, total_shares: totalShares };
  } catch {
    return { name: null, sector: null, category: null, face_value: null, total_shares: null };
  }
}

/**
 * Main entry point — scrape company list and write to staging DB + JSON file.
 *
 * When fetchDetails is true, resume (default on) skips the detail HTTP fetch for
 * symbols that already have a name on file in stg_company_list -- only symbols with
 * no details yet get scraped. The is_active reset below always runs unconditionally
 * for every symbol regardless of resume; only the detail fetch itself is skippable.
 */
export async function scrapeCompanyList({ fetchDetails = false, resume = true } = {}) {
  if (!isScraperEnabled('pipeline.company_list_scraper')) {
    console.log(scraperBlockedMessage('pipeline.company_list_scraper'));
    return { count: 0, symbols: [], blocked: true };
  }
  await initStagingDB();
  const now = new Date().toISOString();

  // 1. Get every equity that traded in the last 30 days from DSE
  const activeSymbols = await fetchActiveSymbolsFromDSE();
  console.log(`[CompanyList] Found ${activeSymbols.length} instruments traded on DSE in the last 30 days.`);

  // 2. Mark all existing records as inactive (fresh start for today)
  await dbRun(`UPDATE stg_company_list SET is_active = 0`);

  // 3. Determine which symbols actually need a detail fetch this run
  let symbolsToFetch = activeSymbols.slice();
  if (fetchDetails && resume) {
    const existingRows = await dbAll(`SELECT symbol FROM stg_company_list WHERE name IS NOT NULL`);
    const existingSet = new Set(existingRows.map(r => r.symbol));
    const before = symbolsToFetch.length;
    symbolsToFetch = symbolsToFetch.filter(s => !existingSet.has(s));
    if (before > symbolsToFetch.length) {
      console.log(`[CompanyList] Resume check: ${before - symbolsToFetch.length} symbols already have details, ${symbolsToFetch.length} remaining to fetch.`);
    }
  }

  // 4. Batch-fetch details for symbols that need them
  const detailsMap = new Map();
  if (fetchDetails && symbolsToFetch.length > 0) {
    console.log(`[CompanyList] Fetching details for ${symbolsToFetch.length} symbols. Concurrency: batches of 6, 250ms between batches.`);
    let processed = 0;
    await runBatched(symbolsToFetch, async (symbol) => {
      const details = await fetchCompanyDetails(symbol);
      detailsMap.set(symbol, details);
      processed++;
      if (processed % 20 === 0) {
        console.log(`[CompanyList] Processed ${processed}/${symbolsToFetch.length} detail fetches...`);
      }
    }, { batchSize: 6, delayMs: 250 });
  }

  // 5. Insert/update every active symbol (fast DB writes; no HTTP call in this loop)
  // No market_cap_mn here -- it's a pricing-derived figure and belongs to
  // fundamentals_scraper.js, which already computes it from stg_price_history's
  // real year-end close (confirmed 2026-08-22: this column was write-only,
  // never read by anything downstream -- company_list's job is "which equities
  // exist and are active," not market cap).
  const results = [];
  let blockedCount = 0;
  for (const symbol of activeSymbols) {
    const details = detailsMap.get(symbol) || { name: null, sector: null, category: null, face_value: null, total_shares: null };

    // Audit gate before the INSERT -- rejects a negative/zero face_value or
    // total_shares outright; a genuinely-unknown one is already null by this point.
    const audit = DataAuditor.auditCompanyListRecord({ symbol, ...details });
    if (!audit.passed) {
      console.warn(`[CompanyList] BLOCKED ${symbol} detail fields by audit (symbol stays active, no bad field written):`, audit.errors);
      blockedCount++;
      // is_active must NOT be collateral damage of a rejected detail record.
      // `symbol` reaching this point already means DSE's day_end_archive (an
      // independent, unrelated data source -- see fetchActiveSymbolsFromDSE)
      // confirmed it traded within the last 30 days; the audit failure above is
      // about one specific detail field DSE's OWN company page published as
      // invalid (e.g. a real "Face/par Value: 0.0" on DSE's own page for some
      // debentures), not about whether the symbol is actually trading. Found
      // 2026-08-24: the `UPDATE ... SET is_active = 0` reset a few lines above
      // runs unconditionally for every symbol, and a `continue` here used to
      // skip the write that would set it back to 1 -- so a real, actively
      // traded symbol with one bad detail field silently flipped to inactive
      // every time this ran. This minimal upsert only ever touches
      // is_active/fetched_at; it never writes a NULL over an existing good
      // detail value (nothing here is in the SET clause) and never writes the
      // rejected bad field at all.
      await dbRun(`
        INSERT INTO stg_company_list (symbol, name, sector, category, face_value, total_shares, is_active, fetched_at)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, 1, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          is_active=1,
          fetched_at=excluded.fetched_at
      `, [symbol, now]);
      results.push({ symbol, name: null, sector: null, category: null, face_value: null, total_shares: null, is_active: 1 });
      continue;
    }
    const clean = audit.cleaned;

    await dbRun(`
      INSERT INTO stg_company_list (symbol, name, sector, category, face_value, total_shares, is_active, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        name=COALESCE(excluded.name, stg_company_list.name),
        sector=COALESCE(excluded.sector, stg_company_list.sector),
        category=COALESCE(excluded.category, stg_company_list.category),
        face_value=COALESCE(excluded.face_value, stg_company_list.face_value),
        total_shares=COALESCE(excluded.total_shares, stg_company_list.total_shares),
        is_active=1,
        fetched_at=excluded.fetched_at
    `, [clean.symbol, clean.name, clean.sector, clean.category, clean.face_value, clean.total_shares, now]);

    results.push({ symbol, ...details, is_active: 1 });
  }
  if (blockedCount > 0) {
    console.warn(`[CompanyList] ${blockedCount} symbol(s) blocked by audit this run.`);
  }

  // 4. Save active symbols to JSON file for other pipeline modules
  const activeList = results.map(r => r.symbol).sort();
  await fs.outputJson(SYMBOLS_FILE, {
    generated_at: now,
    count: activeList.length,
    symbols: activeList
  }, { spaces: 2 });

  console.log(`[CompanyList] ✅ ${results.length} active symbols written to stg_company_list`);
  console.log(`[CompanyList] ✅ Active symbol list saved to: ${SYMBOLS_FILE}`);

  return { count: results.length, symbols: activeList };
}

/**
 * Load active symbols from JSON file (fast — no DB query needed).
 * If file doesn't exist, queries the DB instead.
 */
export async function loadActiveSymbols() {
  if (await fs.pathExists(SYMBOLS_FILE)) {
    const data = await fs.readJson(SYMBOLS_FILE);
    return data.symbols || [];
  }
  // Fallback: query DB
  const rows = await dbAll(`SELECT symbol FROM stg_company_list WHERE is_active = 1 ORDER BY symbol`);
  return rows.map(r => r.symbol);
}
