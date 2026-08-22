/**
 * fundamentals_scraper.js
 *
 * Scrapes ONLY officially disclosed and audited annual financial data
 * from dsebd.org company pages.
 *
 * Rules (per user requirement):
 *   - ONLY import financials officially reported/disclosed by the company
 *   - Never synthetic, estimated, or derived values for anything DSE didn't disclose
 *   - Source must always be 'DSE_OFFICIAL'
 *   - Every field DSE's page actually makes available must be captured -- a field
 *     should only be null because DSE genuinely didn't disclose it for that year
 *     (e.g. no rights issue that year), never because this scraper didn't look for it
 *   - Fiscal year detection: based on the "Year" column of DSE's own per-year tables
 *
 * URL pattern: https://www.dsebd.org/displayCompany.php?name={SYMBOL}
 *
 * The page has two per-year tables (structure confirmed live via raw colspan
 * inspection against AAMRANET, BATBC, and IFIC -- an IT company, a consumer
 * blue-chip, and a bank, to check the layout holds across sectors):
 *  1. "Year | EPS | NAV Per Share | Profit/(Loss) and OCI" -- 12 data cells after
 *     Year, in 4 fixed groups of 3 (Basic-Original, Basic-Restated, Diluted):
 *     [0-2]=headline EPS, [3-5]=EPS-Continuing-Operations, [6-8]=NAV Per Share,
 *     [9-11]=Profit for the year. A company that has no discontinued operations
 *     (the overwhelming majority) leaves the headline EPS group dashed and only
 *     populates the Continuing-Operations group -- so EPS is read from whichever
 *     of the two groups actually has a value, headline taking priority when both
 *     do. Within a populated group, "Restated" (when present) supersedes
 *     "Original", so the LAST non-dash cell in the group wins.
 *  2. "Year | Year end P/E ratio | Dividend in %* | Dividend Yield in %" -- same
 *     8-cells-after-Year shape: [0-2]/[3-5] = P/E via headline/Continuing-Ops EPS
 *     (same headline-then-fallback, last-non-dash-wins resolution), [6] = cash
 *     dividend % (can read "5.00, 5% B" for 5% cash + 5% bonus), [7] = dividend
 *     yield %. Verified against IFIC (a bank) that this holds outside plain
 *     industrial/IT companies too -- extracted eps/navps for FY2025 matched the
 *     already-known-correct values (-13.32 / 4.96) exactly.
 *
 * Fields DSE does NOT publish per historical year (only as a current snapshot, or
 * not at all) are backfilled from data already in the pipeline rather than left
 * empty for no reason: year_end_close from stg_price_history (nearest trade_date
 * on/before Dec 31 of that fiscal year), pb_ratio/roe derived from what's now
 * available, and total_shares/paid_up_capital_mn/market_cap_mn attached to the
 * most recent fiscal year only (from stg_company_list, DSE's current-snapshot
 * figure -- historical year-by-year share counts aren't published anywhere on
 * DSE, so leaving older years null there is accurate, not a scraping gap).
 */

import * as cheerio from 'cheerio';
import { initStagingDB, stageFundamental, dbGet, dbAll } from '../db/staging_db.js';
import { loadActiveSymbols } from './company_list_scraper.js';
import { fetchWithRetry, runBatched } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';
import { numOrNull } from '../../../shared/safe_number.js';

// Exported (not just used internally) so shared/test_suite.js can exercise this
// parsing logic directly against hand-crafted fixtures, without needing a live
// HTTP round-trip to dsebd.org -- see "extensive test cases before write" policy.
// Last non-dash numeric value within a fixed 3-cell (Original/Restated/Diluted)
// group -- "last wins" so a Restated figure supersedes Original when both exist.
export function lastNumberInGroup(cells, startIdx) {
  let val = null;
  for (let i = startIdx; i < startIdx + 3 && i < cells.length; i++) {
    const v = parseFloat(String(cells[i]).replace(/,/g, ''));
    if (!Number.isNaN(v)) val = v;
  }
  return val;
}

// Headline group first (cells[0-2]), falling back to Continuing-Operations
// (cells[3-5]) when the headline group is entirely dashed -- the normal case for
// any company with no discontinued operations to report separately.
export function headlineOrContinuing(cells) {
  return lastNumberInGroup(cells, 0) ?? lastNumberInGroup(cells, 3);
}

async function scrapeCompanyFundamentals(symbol) {
  const url = `https://www.dsebd.org/displayCompany.php?name=${encodeURIComponent(symbol)}`;
  let html;

  try {
    const res = await fetchWithRetry(url, { timeout: 25000, attempts: 3, backoffMs: 2000 });
    html = res.data;
  } catch (err) {
    console.warn(`  [Fundamentals] ⚠️  ${symbol}: Failed after 3 attempts — ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const byYear = new Map(); // fiscal_year -> partial record

  const getRow = (yr) => {
    if (!byYear.has(yr)) byYear.set(yr, { fiscal_year: yr });
    return byYear.get(yr);
  };

  // ── Table 1: EPS + NAV Per Share per year (12 cells after Year: see header
  // comment for the fixed [0-2]/[3-5]/[6-8]/[9-11] group layout) ─────────────
  $('table').each((_, table) => {
    const text = $(table).text();
    if (!(text.includes('NAV Per Share') && text.includes('Earnings per share'))) return;
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td, th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (!cells.length || !/^(19|20)\d{2}$/.test(cells[0])) return;
      const fiscal_year = parseInt(cells[0], 10);
      const data = cells.slice(1);
      const row = getRow(fiscal_year);
      row.eps = headlineOrContinuing(data);
      row.navps = lastNumberInGroup(data, 6);
    });
  });

  // ── Table 2: Year-end P/E, dividend %, dividend yield % per year (8 cells
  // after Year: [0-2]/[3-5] = P/E groups, [6] = dividend %, [7] = dividend yield %) ──
  $('table').each((_, table) => {
    const text = $(table).text();
    if (!(text.includes('Price Earnings (P/E) ratio') && text.includes('Dividend Yield in %'))) return;
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td, th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (!cells.length || !/^(19|20)\d{2}$/.test(cells[0])) return;
      const fiscal_year = parseInt(cells[0], 10);
      const data = cells.slice(1);
      const dividendCellRaw = data[6] ?? null;
      const pe_ratio = headlineOrContinuing(data);
      // numOrNull, not `parseFloat(...) || null`: a dividend yield/% of exactly 0
      // is a real, legitimate value (the company paid no dividend that year), not
      // a sign the cell was unparseable.
      const dividend_yield = data.length > 7 ? numOrNull(data[7]) : null;
      const dividend_pct = dividendCellRaw !== null ? numOrNull(dividendCellRaw) : null;
      const row = getRow(fiscal_year);
      row.pe_ratio = pe_ratio;
      row.dividend_yield = dividend_yield;
      // Bonus % lives in the same cell as the cash dividend %, e.g. "5.00, 5% B"
      const bonusMatch = dividendCellRaw ? dividendCellRaw.match(/(\d+(?:\.\d+)?)\s*%\s*B\b/i) : null;
      row.bonus_pct = bonusMatch ? parseFloat(bonusMatch[1]) : null;
      row.dividend_pct = dividend_pct; // cash %, converted to BDT dps below once face_value is known
    });
  });

  if (byYear.size === 0) return [];

  // ── Company-level lookups needed to finish deriving fields ─────────────────
  const companyRow = await dbGet('SELECT face_value, total_shares FROM stg_company_list WHERE symbol = ?', [symbol]);
  // No assumed face value: BDT 10 is the common case but not universal, and
  // silently assuming it for a company whose real face value isn't in
  // stg_company_list yet would misstate its cash-DPS derivation below.
  const faceValue = numOrNull(companyRow?.face_value);
  const currentTotalShares = numOrNull(companyRow?.total_shares);
  const currentPaidUpCapitalMn = (currentTotalShares !== null && faceValue !== null) ? Number(((currentTotalShares * faceValue) / 1e6).toFixed(4)) : null;
  const maxYear = Math.max(...byYear.keys());

  const results = [];
  for (const [fiscal_year, row] of byYear.entries()) {
    if (row.eps === undefined && row.navps === undefined) continue; // table 1 never matched this year at all
    const eps = row.eps ?? null;
    const navps = row.navps ?? null;

    // Cash DPS in BDT, derived from the disclosed cash-dividend % x face value --
    // DSE discloses dividends as a % of face value, not a BDT-per-share figure.
    const dps = (row.dividend_pct !== undefined && row.dividend_pct !== null && faceValue !== null)
      ? Number(((row.dividend_pct / 100) * faceValue).toFixed(4))
      : null;

    const roe = (eps !== null && navps !== null && navps > 0)
      ? Number(((eps / navps) * 100).toFixed(2))
      : null;

    // year_end_close: nearest real trade_date on/before Dec 31 of this fiscal year,
    // from stg_price_history (already Tier 1/2 only) -- DSE's per-year table doesn't
    // publish a year-end price itself, but we already have the real daily closes.
    const priceRow = await dbGet(
      `SELECT close FROM stg_price_history WHERE symbol = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`,
      [symbol, `${fiscal_year}-12-31`]
    );
    const year_end_close = numOrNull(priceRow?.close);

    const pb_ratio = (year_end_close !== null && navps !== null && navps > 0)
      ? Number((year_end_close / navps).toFixed(3))
      : null;

    // Share count / paid-up capital / market cap are DSE current-snapshot figures
    // only (no historical per-year share count is published anywhere on DSE) --
    // attach to the most recent fiscal year alone, correctly leave older years null.
    const isLatestYear = fiscal_year === maxYear;
    const total_shares = isLatestYear ? currentTotalShares : null;
    const paid_up_capital_mn = isLatestYear ? currentPaidUpCapitalMn : null;
    const market_cap_mn = (isLatestYear && year_end_close !== null && currentTotalShares)
      ? Number(((year_end_close * currentTotalShares) / 1e6).toFixed(4))
      : null;

    if (eps !== null || navps !== null) {
      results.push({
        fiscal_year,
        eps,
        navps,
        dps,
        bonus_pct: row.bonus_pct ?? null,
        rights_ratio: null, // not present anywhere on this page for any symbol checked; left null rather than guessed
        paid_up_capital_mn,
        total_shares,
        year_end_close,
        pe_ratio: row.pe_ratio ?? null,
        pb_ratio,
        roe,
        dividend_yield: row.dividend_yield ?? null,
        market_cap_mn,
        disclosure_date: null, // DSE's per-year table doesn't publish a disclosure date; left honestly null rather than faked as "today"
        source: 'DSE_OFFICIAL',
      });
    }
  }

  return results;
}

/**
 * Scrape fundamentals for ALL active symbols (or a subset).
 * Rate limited to 1.5s between requests.
 */
export async function scrapeFundamentalsForAll({ symbols = null, verbose = true, resume = true } = {}) {
  if (!isScraperEnabled('pipeline.fundamentals_scraper')) {
    console.log(scraperBlockedMessage('pipeline.fundamentals_scraper'));
    return { totalDisclosures: 0, symbolsWithData: 0, symbolsWithNoData: 0, blocked: true };
  }
  await initStagingDB();

  let targetSymbols = symbols || (await loadActiveSymbols());

  if (resume) {
    const existing = await dbAll('SELECT DISTINCT symbol FROM stg_annual_fundamentals');
    const existingSet = new Set(existing.map(r => r.symbol));
    const remaining = targetSymbols.filter(s => !existingSet.has(s));
    if (existingSet.size > 0) {
      console.log(`[Fundamentals] Resume check: ${existingSet.size} symbols already processed, ${remaining.length} remaining.`);
    }
    targetSymbols = remaining;
  }

  console.log(`[Fundamentals] Scraping official fundamentals for ${targetSymbols.length} active symbols...`);
  console.log(`[Fundamentals] Source: dsebd.org official company pages`);
  console.log(`[Fundamentals] Rule: ONLY officially disclosed/audited data will be imported.`);
  console.log(`[Fundamentals] Concurrency: batches of 6, 250ms between batches.\n`);

  let totalDisclosures = 0;
  let symbolsWithData = 0;
  let symbolsWithNoData = 0;
  let totalBlockedYears = 0;
  let processed = 0;

  await runBatched(targetSymbols, async (symbol) => {
    try {
      const disclosures = await scrapeCompanyFundamentals(symbol);
      processed++;

      if (disclosures.length > 0) {
        // Audit gate before stageFundamental. auditFinancialStatements' `cleaned`
        // drops rights_ratio/total_shares/year_end_close/market_cap_mn/
        // disclosure_date (shaped for the simpler ingest-endpoint statement, not
        // this scraper's fuller record) -- so on a pass, stage the ORIGINAL
        // per-year disclosures for whichever fiscal years actually survived.
        const audit = DataAuditor.auditFinancialStatements(symbol, disclosures);
        if (audit.errors.length > 0) {
          console.warn(`  [${processed}/${targetSymbols.length}] ${symbol}: ${audit.errors.length} year(s) BLOCKED by audit -`, audit.errors);
        }
        const survivingYears = new Set(audit.cleaned.map(c => c.year));
        const toStage = disclosures.filter(d => survivingYears.has(d.fiscal_year));
        totalBlockedYears += disclosures.length - toStage.length;

        for (const disclosure of toStage) {
          await stageFundamental({ symbol, ...disclosure });
        }
        totalDisclosures += toStage.length;
        if (toStage.length > 0) symbolsWithData++;

        if (verbose) {
          console.log(`  [${processed}/${targetSymbols.length}] ${symbol}: ${toStage.length} annual disclosures staged`);
        }
      } else {
        symbolsWithNoData++;
        if (verbose) {
          console.log(`  [${processed}/${targetSymbols.length}] ${symbol}: No official disclosures found on DSE page`);
        }
      }

      if (processed % 50 === 0) {
        console.log(`\n[Fundamentals] Progress: ${processed}/${targetSymbols.length} symbols processed, ${totalDisclosures} total disclosures staged.\n`);
      }
    } catch (err) {
      processed++;
      console.error(`  [${processed}/${targetSymbols.length}] ${symbol}: ERROR — ${err.message}`);
    }
  }, { batchSize: 6, delayMs: 250 });

  console.log(`\n[Fundamentals] ✅ Official Fundamentals Scraping Complete:`);
  console.log(`   Symbols processed:         ${targetSymbols.length}`);
  console.log(`   Symbols with disclosures:  ${symbolsWithData}`);
  console.log(`   Symbols with no data:      ${symbolsWithNoData} (bonds/MFs/new listings)`);
  console.log(`   Total disclosures staged:  ${totalDisclosures}`);
  console.log(`   Years blocked by audit:    ${totalBlockedYears}`);
  console.log(`   Source: DSE_OFFICIAL (all data is from official company disclosures)`);

  return { totalDisclosures, symbolsWithData, symbolsWithNoData, totalBlockedYears };
}
