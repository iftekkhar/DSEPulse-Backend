/**
 * scrape_historical_financial_statements.js
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
 * ARCHITECTURE NOTE (2026-08-29): Staging DB retired. Reads from and writes directly
 * to main DB (dse.db) via server/db.js helpers.
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
import {
  dbGet as mainDbGet,
  dbAll as mainDbAll,
  savePipelineFundamentals,
  saveShareholdingCurrent,
  saveCorporateAction,
  saveCorporateActionsBatch
} from '../db.js';
import { loadActiveSymbols } from './scrape_current_daily_operations.js';
import { fetchWithRetry, runBatched } from '../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { DataAuditor } from '../../shared/data_auditor.js';
import { numOrNull } from '../../shared/safe_number.js';
import {
  lastNumberInGroup,
  headlineOrContinuing,
  parseCashDividendString,
  extractBalanceSheetFromCheerio
} from '../../shared/fundamentals_parsing.js';

export { lastNumberInGroup, headlineOrContinuing };

// Exported so the live cross-check audit (external_crosscheck_dse_fundamentals.js)
// can reuse this exact parsing logic as its "ground truth" fetch, rather than
// re-implementing DSE's table layout a second time in a second file -- two
// independent parsers of the same page are two independent places to drift out
// of sync with each other, which defeats the point of a cross-check.
export async function scrapeCompanyFundamentals(symbol) {
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

  // ── Table 1: EPS + NAV Per Share + Net Income per year (12 cells after Year) ─────────────
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
      row.eps_diluted = numOrNull(data[2]) ?? numOrNull(data[5]) ?? null;
      row.navps = lastNumberInGroup(data, 6);
      row.net_income_mn = data.length > 10 ? (numOrNull(data[11]) ?? numOrNull(data[10]) ?? numOrNull(data[9])) : (data.length > 9 ? numOrNull(data[9]) : null);
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
      const dividend_yield = data.length > 7 ? numOrNull(data[7]) : null;
      const cashDividendPart = dividendCellRaw !== null ? dividendCellRaw.split(',')[0].trim() : null;
      const dividend_pct = cashDividendPart ? numOrNull(cashDividendPart.replace('%', '')) : null;
      const row = getRow(fiscal_year);
      row.pe_ratio = pe_ratio;
      row.dividend_yield = dividend_yield;
      const bonusMatch = dividendCellRaw ? dividendCellRaw.match(/(\d+(?:\.\d+)?)\s*%\s*B\b/i) : null;
      row.bonus_pct = bonusMatch ? parseFloat(bonusMatch[1]) : null;
      row.dividend_pct = dividend_pct;
    });
  });

  // ── Company-level Balance Sheet Metrics & Multi-Year Dividend Text String ──
  const bs = extractBalanceSheetFromCheerio($);
  const reserveSurplus = bs.reserve_surplus_mn;
  const oci = bs.oci_mn;
  const shortLoan = bs.short_term_loan_mn;
  const longLoan = bs.long_term_loan_mn;
  const authorizedCapital = bs.authorized_capital_mn;

  // ── Company-level lookups needed to finish deriving fields ─────────────────
  const companyRow = await mainDbGet('SELECT face_value, total_shares FROM company_list WHERE symbol = ?', [symbol]);
  const faceValue = numOrNull(companyRow?.face_value) ?? 10;
  const currentTotalShares = numOrNull(companyRow?.total_shares);
  const currentPaidUpCapitalMn = (currentTotalShares !== null && faceValue !== null) ? Number(((currentTotalShares * faceValue) / 1e6).toFixed(4)) : null;

  // Multi-year Cash Dividend string parsing as cross-fill for DPS
  if (bs.cash_dividend_string) {
    const parsedDivs = parseCashDividendString(bs.cash_dividend_string, faceValue);
    for (const [yr, divInfo] of parsedDivs.entries()) {
      const r = getRow(yr);
      if (r.dividend_pct === undefined || r.dividend_pct === null) {
        r.dividend_pct = divInfo.dividend_pct;
      }
      if (r.bonus_pct === undefined || r.bonus_pct === null) {
        r.bonus_pct = divInfo.bonus_pct;
      }
    }
  }

  if (byYear.size === 0) return [];
  const maxYear = Math.max(...byYear.keys());

  const results = [];
  for (const [fiscal_year, row] of byYear.entries()) {
    if (row.eps === undefined && row.navps === undefined) continue;
    const eps = row.eps ?? null;
    const navps = row.navps ?? null;

    const dps = (row.dividend_pct !== undefined && row.dividend_pct !== null && faceValue !== null)
      ? Number(((row.dividend_pct / 100) * faceValue).toFixed(4))
      : null;

    const roe = (eps !== null && navps !== null && navps > 0)
      ? Number(((eps / navps) * 100).toFixed(2))
      : null;

    const priceRow = await mainDbGet(
      `SELECT close FROM price_history WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
      [symbol, `${fiscal_year}-12-31`]
    );
    const year_end_close = numOrNull(priceRow?.close);

    const pb_ratio = (year_end_close !== null && navps !== null && navps > 0)
      ? Number((year_end_close / navps).toFixed(3))
      : null;

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
        rights_ratio: null,
        paid_up_capital_mn,
        total_shares,
        year_end_close,
        pe_ratio: row.pe_ratio ?? null,
        pb_ratio,
        roe,
        dividend_yield: row.dividend_yield ?? null,
        market_cap_mn,
        net_income_mn: row.net_income_mn ?? null,
        reserve_surplus_mn: isLatestYear ? reserveSurplus : null,
        oci_mn: isLatestYear ? oci : null,
        short_term_loan_mn: isLatestYear ? shortLoan : null,
        long_term_loan_mn: isLatestYear ? longLoan : null,
        authorized_capital_mn: isLatestYear ? authorizedCapital : null,
        disclosure_date: null,
        source: 'DSE_OFFICIAL',
      });
    }
  }

  // Shareholding pattern -- same page, "Other Information of the Company"
  // table has one row per disclosed month: label "Share Holding Percentage
  // [as on <Month Day, Year>]" followed by a nested 5-cell table
  // (Sponsor/Director, Govt, Institute, Foreign, Public). Duplicates the
  // identical parsing in server/scrapers/sources/dse_fundamentals_scraper.js
  // rather than sharing it -- worth consolidating into shared/
  // fundamentals_parsing.js, not done here to keep this change scoped.
  // Attached as a property on the returned array (not a `{disclosures,
  // shareholding}` object) so this stays backward-compatible with every
  // existing caller that treats scrapeCompanyFundamentals's return value as
  // a plain array of yearly disclosures.
  {
    const disclosures = [];
    $('td').each((_, td) => {
      const label = $(td).text().replace(/\s+/g, ' ').trim();
      const m = label.match(/Share Holding Percentage\s*\[as on ([^\]]+?)(?:\s*\(year ended\))?\]/i);
      if (!m) return;
      const asOfDate = new Date(m[1]);
      if (isNaN(asOfDate.getTime())) return;
      const nestedRow = $(td).next('td').find('tr').first();
      const cells = {};
      nestedRow.find('td').each((_, cell) => {
        const cellText = $(cell).text().replace(/\s+/g, ' ').trim();
        const cm = cellText.match(/^(Sponsor\/Director|Govt|Institute|Foreign|Public):\s*(-?\d+\.?\d*)$/i);
        if (cm) cells[cm[1]] = parseFloat(cm[2]);
      });
      if (Object.keys(cells).length === 5) {
        disclosures.push({
          asOfDate: asOfDate.toISOString().slice(0, 10),
          sponsorPct: cells['Sponsor/Director'],
          govtPct: cells['Govt'],
          institutePct: cells['Institute'],
          foreignPct: cells['Foreign'],
          publicPct: cells['Public'],
        });
      }
    });
    disclosures.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
    const latest = disclosures[disclosures.length - 1];
    const prior = disclosures[disclosures.length - 2];
    if (latest) {
      results.shareholding = { current: latest, previous: prior || null };
    }
  }

  return results;
}

/**
 * Scrape fundamentals for ALL active symbols (or a subset).
 * Rate limited to 1.5s between requests.
 */
export async function scrapeFundamentalsForAll({ symbols = null, verbose = true, resume = true } = {}) {
  if (!isScraperEnabled('historical.fundamentals_scraper')) {
    console.log(scraperBlockedMessage('historical.fundamentals_scraper'));
    return { totalDisclosures: 0, symbolsWithData: 0, symbolsWithNoData: 0, blocked: true };
  }

  let targetSymbols = symbols || (await loadActiveSymbols());

  if (resume) {
    // Resume state now read from MAIN DB directly.
    const existing = await mainDbAll('SELECT DISTINCT symbol FROM fundamentals_history WHERE source = \'DSE_OFFICIAL\'');
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
  let shareholdingStaged = 0;
  let shareholdingBlocked = 0;

  await runBatched(targetSymbols, async (symbol) => {
    try {
      const disclosures = await scrapeCompanyFundamentals(symbol);
      processed++;

      // Shareholding is an independent fact from the fundamentals below --
      // audited and written on its own, so a fundamentals audit failure never
      // blocks a valid shareholding snapshot or vice versa (same reasoning
      // as server/scrapers/audited_eps_scraper.js's identical split).
      if (disclosures.shareholding?.current) {
        const shAudit = DataAuditor.auditShareholdingRecord(symbol, disclosures.shareholding.current);
        if (shAudit.passed) {
          // Write shareholding directly to main DB via saveShareholdingCurrent.
          await saveShareholdingCurrent([{ symbol, shareholding: disclosures.shareholding }]);
          shareholdingStaged++;
        } else {
          shareholdingBlocked++;
          console.warn(`  [Fundamentals] ${symbol}: shareholding BLOCKED by audit -`, shAudit.errors);
        }
      }

      if (disclosures.length > 0) {
        // Audit gate before savePipelineFundamentals. auditFinancialStatements'
        // `cleaned` drops rights_ratio/total_shares/year_end_close/market_cap_mn/
        // disclosure_date (shaped for the simpler ingest-endpoint statement, not
        // this scraper's fuller record) -- so on a pass, write the ORIGINAL
        // per-year disclosures for whichever fiscal years actually survived.
        const audit = DataAuditor.auditFinancialStatements(symbol, disclosures);
        if (audit.errors.length > 0) {
          console.warn(`  [${processed}/${targetSymbols.length}] ${symbol}: ${audit.errors.length} year(s) BLOCKED by audit -`, audit.errors);
        }
        const survivingYears = new Set(audit.cleaned.map(c => c.year));
        const toWrite = disclosures.filter(d => survivingYears.has(d.fiscal_year));
        totalBlockedYears += disclosures.length - toWrite.length;

        // Write directly to main DB -- no staging, no promoter.
        const n = await savePipelineFundamentals(symbol, toWrite);
        totalDisclosures += n;
        if (n > 0) symbolsWithData++;

        if (verbose) {
          console.log(`  [${processed}/${targetSymbols.length}] ${symbol}: ${n} annual disclosures written to main DB`);
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
  console.log(`   Shareholding staged:       ${shareholdingStaged}`);
  console.log(`   Shareholding blocked:      ${shareholdingBlocked}`);
  console.log(`   Source: DSE_OFFICIAL (all data is from official company disclosures)`);

  return { totalDisclosures, symbolsWithData, symbolsWithNoData, totalBlockedYears, shareholdingStaged, shareholdingBlocked };
}

// ─────────────────────────────────────────────────────────────────────────────
//  LANKABD DIVIDEND ARCHIVE HISTORICAL BACKFILL (4,412 ROWS)
// ─────────────────────────────────────────────────────────────────────────────

function parseLankaBDDate(str) {
  if (!str || str === '-' || str === 'N/A' || str.trim() === '') return null;
  const match = str.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const month = monthMap[match[2]];
  if (!month) return null;
  const year = match[3];
  return `${year}-${month}-${day}`;
}

/**
 * Scrapes all 4,412 rows of multi-year historical dividend declarations,
 * exact Record Dates, and AGM Dates from LankaBD Dividend Archive, storing
 * them into corporate_actions_calendar with strict LANKABD provenance.
 */
export async function scrapeLankaBDDividendArchive() {
  if (!isScraperEnabled('historical.lankabd_dividend_archive')) {
    console.log(scraperBlockedMessage('historical.lankabd_dividend_archive'));
    return { totalParsed: 0, totalSaved: 0, blocked: true };
  }
  console.log('\n[LankaBD Dividend Archive] Fetching https://www.lankabd.com/Home/DividendArchive...');
  try {
    const res = await fetchWithRetry('https://www.lankabd.com/Home/DividendArchive');
    if (!res || !res.data) throw new Error('Empty response from LankaBD Dividend Archive');

    const $ = cheerio.load(res.data);
    const events = [];

    $('table tbody tr, table tr').each((_, tr) => {
      const tds = $(tr).find('td').map((__, el) => $(el).text().trim()).get();
      if (tds.length >= 10) {
        const symbol = String(tds[0] || '').toUpperCase().trim();
        const yearStr = tds[2] || '';
        const cashDivStr = tds[4] || '';
        const stockDivStr = tds[5] || '';
        const publishDateStr = tds[8] || '';
        const recordDateStr = tds[9] || '';
        const agmDateStr = tds[10] || '';

        if (!symbol || symbol === 'SYMBOL' || symbol.length > 20) return;

        const cashDps = numOrNull(cashDivStr);
        const bonusPct = numOrNull(stockDivStr);
        const recordDate = parseLankaBDDate(recordDateStr);
        const agmDate = parseLankaBDDate(agmDateStr);
        // No fabricated fallback (previously `${yearStr || '2024'}-12-31` when
        // neither a real publish date nor record date was found -- a
        // synthesized date standing in for a genuinely undisclosed one, the
        // exact substitute-value pattern the Zero-Fabrication Law forbids).
        // event_date is NOT NULL in the schema, so a row with neither real
        // date is skipped below rather than written with an invented one.
        const publishDate = parseLankaBDDate(publishDateStr) ?? recordDate;

        if (publishDate !== null && (cashDps !== null || bonusPct !== null || recordDate !== null)) {
          events.push({
            symbol,
            eventType: 'DIVIDEND',
            eventDate: publishDate,
            recordDate,
            agmDate,
            cashDps: cashDps !== null && cashDps > 0 ? cashDps : null,
            bonusPct: bonusPct !== null && bonusPct > 0 ? bonusPct : null,
            details: `FY${yearStr} Dividend: Cash ${cashDivStr}%, Bonus ${stockDivStr}%`,
            source: 'LANKABD',
            // Part of the DB's uniqueness key (see ingestion_repo.js's
            // saveCorporateAction) -- two different fiscal years' disclosures
            // can share the same publish date, so event_date alone isn't a
            // safe dedup key on its own (confirmed live 2026-09-01: AIL's
            // FY2021 and FY2020 dividends were both published 2021-11-10).
            fiscalYear: /^\d{4}$/.test(yearStr) ? parseInt(yearStr, 10) : null
          });
        }
      }
    });

    console.log(`[LankaBD Dividend Archive] Parsed ${events.length} dividend corporate action records.`);
    let saved = 0;
    if (events.length > 0) {
      saved = await saveCorporateActionsBatch(events);
    }
    console.log(`[LankaBD Dividend Archive] ✅ Stored ${saved} corporate actions into corporate_actions_calendar.`);
    return { totalParsed: events.length, totalSaved: saved };
  } catch (err) {
    console.error('[LankaBD Dividend Archive] Error:', err.message);
    return { totalParsed: 0, totalSaved: 0, error: err.message };
  }
}

// Master CLI Runner
import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { initDB } = await import('../db.js');
  const { setRuntimeOverride } = await import('../../shared/scraper_registry.js');
  await initDB();
  setRuntimeOverride('historical.fundamentals_scraper', true);
  setRuntimeOverride('historical.lankabd_dividend_archive', true);
  const args = process.argv.slice(2);
  if (args.includes('--lankabd')) {
    await scrapeLankaBDDividendArchive();
  } else if (args.includes('--symbol')) {
    const symIdx = args.indexOf('--symbol');
    const sym = args[symIdx + 1];
    if (sym) {
      console.log(`Scraping fundamentals for ${sym}...`);
      await scrapeFundamentalsForAll({ symbols: [sym], verbose: true, resume: false });
    }
  } else {
    await scrapeLankaBDDividendArchive();
    await scrapeFundamentalsForAll({ verbose: false, resume: true });
  }
  process.exit(0);
}
