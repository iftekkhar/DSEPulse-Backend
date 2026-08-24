import * as cheerio from 'cheerio';
import { dbAll, saveFundamentalsBulkDelta, saveShareholdingCurrent } from '../db.js';
import { DataAuditor } from '../../shared/data_auditor.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { fetchWithRetry } from '../../shared/dse_http_client.js';
import { headlineOrContinuing, lastNumberInGroup } from '../../shared/fundamentals_parsing.js';

/**
 * Dedicated Audited EPS & Financial Statements Parser for DSE
 * Crawls official company disclosure page and extracts verified audited financials.
 */
export async function scrapeCompanyAuditedFinancials(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return null;

  const url = `https://www.dsebd.org/displayCompany.php?name=${encodeURIComponent(cleanSym)}`;
  
  try {
    // This function is the sole fetch path for both the daily Job 3 delta
    // (server/index.js, ~640 symbols every production day) and the weekly
    // full scraper below -- retried with backoff so one transient failure
    // doesn't just permanently count that symbol as "unchanged" for the day.
    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000,
      attempts: 3,
      backoffMs: 2000
    });

    if (!res.data || res.status !== 200) return null;

    const $ = cheerio.load(res.data);
    const data = {
      symbol: cleanSym,
      name: '',
      sector: '',
      category: 'A',
      epsBasic: null,
      epsDiluted: null,
      epsQuarterly: null,
      navPerShare: null,
      paidUpCapitalMn: null,
      authorizedCapitalMn: null,
      peBasic: null,
      peDiluted: null,
      peTrailing: null,
      dividendYield: null,
      debtToEquity: null,
      currentRatio: null,
      auditedPeriod: null,
      quarterlyDisclosure: null,
      shareholding: null
    };

    // Shareholding pattern -- same page, "Other Information of the Company"
    // table has one row per disclosed month: label "Share Holding Percentage
    // [as on <Month Day, Year>]" followed by a nested 5-cell table
    // (Sponsor/Director, Govt, Institute, Foreign, Public, each summing to
    // ~100%). DSE publishes the year-end figure plus the last ~2 monthly
    // snapshots on every page load -- confirmed live 2026-08-24. Per the
    // agreed scope, only current + the immediately-prior disclosed month are
    // kept (not a growing history): take the two highest-dated rows found.
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
        data.shareholding = { current: latest, previous: prior || null };
      }
    }

    // 1. Extract Sector, Category, Authorized & Paid-Up Capital
    $('table tr').each((_, tr) => {
      const cols = [];
      $(tr).find('td, th').each((_, el) => {
        cols.push($(el).text().replace(/\s+/g, ' ').trim());
      });

      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        if (col.includes('Authorized Capital (mn)') && cols[i + 1]) {
          const num = parseFloat(cols[i + 1].replace(/,/g, ''));
          if (!isNaN(num) && num > 0) data.authorizedCapitalMn = num;
        }
        if (col.includes('Paid-up Capital (mn)') && cols[i + 1]) {
          const num = parseFloat(cols[i + 1].replace(/,/g, ''));
          if (!isNaN(num) && num > 0) data.paidUpCapitalMn = num;
        }
        if (col.includes('Sector') && cols[i + 1]) {
          data.sector = cols[i + 1];
        }
        if (col.includes('Category') && cols[i + 1]) {
          data.category = cols[i + 1].toUpperCase();
        }
      }
    });

    // 2. Identify Table 1: Financial Performance (EPS, NAVPS) & Table 2: Valuation (Dividend Yield, P/E)
    let latestYear = 0;
    let latestEps = null;
    let latestNav = null;
    let latestDivYield = null;
    let latestPe = null;

    $('table').each((_, tbl) => {
      const tblText = $(tbl).text();
      const isPerfTable = tblText.includes('Financial Performance') || (tblText.includes('NAV Per Share') && tblText.includes('Earnings per share'));
      const isValTable = tblText.includes('Dividend Yield in %') || tblText.includes('Price Earnings (P/E) ratio');

      if (isPerfTable) {
        $(tbl).find('tr').each((_, tr) => {
          const cols = [];
          $(tr).find('td, th').each((_, c) => cols.push($(c).text().replace(/\s+/g, ' ').trim()));

          if (cols.length >= 4 && cols[0].match(/^(19|20)\d{2}$/)) {
            const yr = parseInt(cols[0], 10);
            // DSE's per-year table lays this out in fixed 3-cell groups:
            // [0-2]=headline EPS, [3-5]=EPS-Continuing-Operations, [6-8]=NAV
            // Per Share (see shared/fundamentals_parsing.js). The previous
            // `nums[0]`/`nums[1]` here just took the first two non-dash
            // numbers across the whole flattened row -- which happened to
            // often land on the right cells (the overwhelming majority of
            // companies leave the headline EPS group entirely dashed), but
            // silently picked the wrong value whenever a company DID report
            // discontinued operations (headline group populated) or restated
            // a prior EPS figure (Restated must supersede Original within the
            // same group, not just "whichever numeric cell came first").
            const dataCells = cols.slice(1);
            const eps = headlineOrContinuing(dataCells);
            const navps = lastNumberInGroup(dataCells, 6);

            if (yr >= latestYear && eps !== null) {
              latestYear = yr;
              latestEps = eps;
              latestNav = navps;
            }
          }
        });
      }

      if (isValTable) {
        $(tbl).find('tr').each((_, tr) => {
          const cols = [];
          $(tr).find('td, th').each((_, c) => cols.push($(c).text().replace(/\s+/g, ' ').trim()));

          if (cols.length >= 4 && cols[0].match(/^(19|20)\d{2}$/)) {
            const nums = cols.slice(1).map(c => {
              const cleaned = c.replace(/,/g, '');
              const val = parseFloat(cleaned);
              return isNaN(val) ? null : val;
            }).filter(n => n !== null);

            if (nums.length >= 2) {
              if (latestDivYield === null) latestDivYield = nums[0];
              if (latestPe === null) latestPe = nums[1];
            }
          }
        });
      }
    });

    if (latestEps !== null) {
      data.epsBasic = latestEps;
      data.epsDiluted = latestEps;
      data.navPerShare = latestNav;
      data.dividendYield = latestDivYield;
      data.peBasic = latestPe;
      data.auditedPeriod = `FY${latestYear} Audited`;
      data.quarterlyDisclosure = `FY${latestYear} Audited`;
      return data;
    }

    // 3. Fallback: Parse Continuous Disclosure / Paragraph Notes
    $('td, p, div').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.includes('Basic EPS') && text.includes('Tk.') && !data.epsBasic) {
        const m = text.match(/Basic EPS\s*(?:Tk\.?)?\s*(-?\d+\.?\d*)/i);
        if (m) data.epsBasic = parseFloat(m[1]);
      }
      if (text.includes('NAV per share') && text.includes('Tk.') && !data.navPerShare) {
        const m = text.match(/NAV per share\s*(?:Tk\.?)?\s*(-?\d+\.?\d*)/i);
        if (m) data.navPerShare = parseFloat(m[1]);
      }
    });

    return data.epsBasic !== null ? data : null;
  } catch (err) {
    console.warn(`[AUDITED SCRAPER] Notice on ${cleanSym}:`, err.message);
    return null;
  }
}

/**
 * Runs the Weekly Master Audited EPS Scraper over all listed symbols.
 * Performs fast batch smart delta checks - only writes to SQLite when a value has genuinely changed.
 */
export async function runAuditedEPSWeeklyScraper(concurrency = 6) {
  if (!isScraperEnabled('server.fundamentals_weekly')) {
    console.log(scraperBlockedMessage('server.fundamentals_weekly'));
    return { success: false, blocked: true };
  }
  const startTime = Date.now();
  console.log('\n======================================================');
  console.log('  🔍 Starting Weekly Audited EPS & Fundamentals Crawler');
  console.log('======================================================');

  // company_fundamentals dropped 2026-08-23 (see ARCHITECTURE.md) -- target
  // pool is now every symbol with at least one fundamentals_history row.
  const rows = await dbAll(`SELECT DISTINCT symbol FROM fundamentals_history ORDER BY symbol ASC`);
  const symbols = rows.map(r => r.symbol);

  console.log(`[AUDITED SCRAPER] Target pool: ${symbols.length} listed equities in SQLite DB`);

  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalFailed = 0;
  let totalBlocked = 0;
  const allUpdatedSymbols = [];

  let totalShareholdingSaved = 0;

  // Batch execution with concurrency control and bulk delta saving
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const scrapedRecords = [];
    const shareholdingRecords = [];

    await Promise.all(batch.map(async (sym) => {
      try {
        const scraped = await scrapeCompanyAuditedFinancials(sym);
        if (!scraped || scraped.epsBasic === null) {
          totalUnchanged++;
          return;
        }
        // Shareholding is an independent fact from the fundamentals below --
        // audited and saved on its own, so a fundamentals audit failure
        // never blocks a valid shareholding snapshot or vice versa.
        if (scraped.shareholding?.current) {
          const shAudit = DataAuditor.auditShareholdingRecord(sym, scraped.shareholding.current);
          if (shAudit.passed) {
            shareholdingRecords.push({ symbol: sym, shareholding: scraped.shareholding });
          } else {
            console.warn(`[AUDITED SCRAPER] Shareholding BLOCKED ${sym}:`, shAudit.errors);
          }
        }
        // Audit gate before this reaches saveFundamentalsBulkDelta -- same
        // 1-element-statements-array pattern used in server/index.js's Job 3
        // (this scraper feeds the same table via the same delta-save function).
        const yearMatch = String(scraped.auditedPeriod || '').match(/FY(\d{4})/);
        const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
        const audit = DataAuditor.auditFinancialStatements(sym, [{
          year,
          eps: scraped.epsBasic,
          navps: scraped.navPerShare,
          dps: null,
          bonus_pct: null,
          pe_ratio: scraped.peBasic,
          pb_ratio: null,
          dividend_yield: scraped.dividendYield,
          paid_up_capital_mn: scraped.paidUpCapitalMn,
          source: 'DSE_OFFICIAL'
        }]);
        if (!audit.passed) {
          console.warn(`[AUDITED SCRAPER] BLOCKED ${sym} by audit:`, audit.errors);
          totalBlocked++;
          return;
        }
        scrapedRecords.push(scraped);
      } catch {
        totalFailed++;
      }
    }));

    if (scrapedRecords.length > 0) {
      const deltaResult = await saveFundamentalsBulkDelta(scrapedRecords);
      totalUpdated += deltaResult.changedCount;
      totalUnchanged += deltaResult.unchangedCount;
      allUpdatedSymbols.push(...deltaResult.changedSymbols);

      for (const s of deltaResult.changedSymbols) {
        console.log(`[AUDITED SCRAPER] ✅ Smart Delta: Updated ${s}`);
      }
    }

    if (shareholdingRecords.length > 0) {
      const shResult = await saveShareholdingCurrent(shareholdingRecords);
      totalShareholdingSaved += shResult.saved;
    }

    // Polite delay between batches to respect DSE servers
    await new Promise(r => setTimeout(r, 250));
  }

  const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));
  console.log('======================================================');
  console.log(`[AUDITED SCRAPER] Completed in ${durationSeconds}s`);
  console.log(`[AUDITED SCRAPER] Checked: ${symbols.length} | Updated: ${totalUpdated} | Unchanged: ${totalUnchanged} | Blocked: ${totalBlocked} | Errors: ${totalFailed} | Shareholding saved: ${totalShareholdingSaved}`);
  console.log('======================================================\n');

  return {
    success: true,
    totalChecked: symbols.length,
    updated: totalUpdated,
    unchanged: totalUnchanged,
    blocked: totalBlocked,
    failed: totalFailed,
    shareholdingSaved: totalShareholdingSaved,
    durationSeconds,
    updatedSymbols: allUpdatedSymbols
  };
}
