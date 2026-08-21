import axios from 'axios';
import https from 'https';
import * as cheerio from 'cheerio';
import { dbAll, saveFundamentalsBulkDelta } from '../db.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Dedicated Audited EPS & Financial Statements Parser for DSE
 * Crawls official company disclosure page and extracts verified audited financials.
 */
export async function scrapeCompanyAuditedFinancials(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return null;

  const url = `https://www.dsebd.org/displayCompany.php?name=${encodeURIComponent(cleanSym)}`;
  
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      httpsAgent,
      timeout: 20000
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
      quarterlyDisclosure: null
    };

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
            const nums = cols.slice(1).map(c => {
              const cleaned = c.replace(/,/g, '');
              const val = parseFloat(cleaned);
              return isNaN(val) ? null : val;
            }).filter(n => n !== null);

            if (yr >= latestYear && nums.length >= 2) {
              latestYear = yr;
              latestEps = nums[0];
              latestNav = nums[1];
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
  const startTime = Date.now();
  console.log('\n======================================================');
  console.log('  🔍 Starting Weekly Audited EPS & Fundamentals Crawler');
  console.log('======================================================');

  const rows = await dbAll(`SELECT symbol FROM company_fundamentals ORDER BY symbol ASC`);
  const symbols = rows.map(r => r.symbol);

  console.log(`[AUDITED SCRAPER] Target pool: ${symbols.length} listed equities in SQLite DB`);

  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalFailed = 0;
  const allUpdatedSymbols = [];

  // Batch execution with concurrency control and bulk delta saving
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const scrapedRecords = [];

    await Promise.all(batch.map(async (sym) => {
      try {
        const scraped = await scrapeCompanyAuditedFinancials(sym);
        if (scraped && scraped.epsBasic !== null) {
          scrapedRecords.push(scraped);
        } else {
          totalUnchanged++;
        }
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

    // Polite delay between batches to respect DSE servers
    await new Promise(r => setTimeout(r, 250));
  }

  const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));
  console.log('======================================================');
  console.log(`[AUDITED SCRAPER] Completed in ${durationSeconds}s`);
  console.log(`[AUDITED SCRAPER] Checked: ${symbols.length} | Updated: ${totalUpdated} | Unchanged: ${totalUnchanged} | Errors: ${totalFailed}`);
  console.log('======================================================\n');

  return {
    success: true,
    totalChecked: symbols.length,
    updated: totalUpdated,
    unchanged: totalUnchanged,
    failed: totalFailed,
    durationSeconds,
    updatedSymbols: allUpdatedSymbols
  };
}
