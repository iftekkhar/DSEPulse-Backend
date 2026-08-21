import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DSE_COMPANY_URL = 'https://www.dsebd.org/displayCompany.php?name=';

/**
 * Scrapes detailed audited fundamentals for a given symbol from DSE
 */
export async function scrapeCompanyFundamentals(symbol) {
  if (!symbol) return null;
  const cleanSym = String(symbol).toUpperCase().trim();
  const url = `${DSE_COMPANY_URL}${encodeURIComponent(cleanSym)}`;

  try {
    const res = await axios.get(url, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(res.data);
    const textContent = $('body').text();

    // Name & Sector
    const companyTitle = $('h2.BodyHead:contains("Company Name:")').text().replace('Company Name:', '').trim() ||
      $('td:contains("Company Name")').next().text().trim() || cleanSym;

    const sector = $('td:contains("Sector")').next().text().trim() || 'Equities';
    const category = $('td:contains("Category")').next().text().trim() || 'A';

    // Basic & Diluted EPS
    let epsBasic = null;
    const epsMatch = textContent.match(/EPS\s*(?:basic|continuing)?\s*(?:is|Tk\.?|:)?\s*\(?(-?[0-9]+\.[0-9]+)\)?/i) ||
      textContent.match(/Earnings\s*Per\s*Share\s*(?:is|Tk\.?|:)?\s*\(?(-?[0-9]+\.[0-9]+)\)?/i);
    if (epsMatch) {
      epsBasic = parseFloat(epsMatch[1]);
      if (epsMatch[0].includes('(')) epsBasic = -Math.abs(epsBasic);
    }

    // Net Asset Value per share (NAVPS)
    let navps = null;
    const navMatch = textContent.match(/NAV\s*per\s*share\s*(?:is|Tk\.?|:)?\s*\(?([0-9]+\.[0-9]+)\)?/i) ||
      textContent.match(/Net\s*Asset\s*Value\s*per\s*share\s*(?:is|Tk\.?|:)?\s*\(?([0-9]+\.[0-9]+)\)?/i);
    if (navMatch) {
      navps = parseFloat(navMatch[1]);
    }

    // Paid-up Capital
    let paidUpCapitalMn = null;
    const paidUpMatch = textContent.match(/Paid-up\s*Capital\s*\(?mn\)?\s*\(?(?:Tk\.?|:)?\s*([0-9,]+\.?[0-9]*)/i);
    if (paidUpMatch) {
      paidUpCapitalMn = parseFloat(paidUpMatch[1].replace(/,/g, ''));
    }

    // Authorized Capital
    let authorizedCapitalMn = null;
    const authMatch = textContent.match(/Authorized\s*Capital\s*\(?mn\)?\s*\(?(?:Tk\.?|:)?\s*([0-9,]+\.?[0-9]*)/i);
    if (authMatch) {
      authorizedCapitalMn = parseFloat(authMatch[1].replace(/,/g, ''));
    }

    // Dividend Yield
    let dividendYield = null;
    const divMatch = textContent.match(/Dividend\s*Yield\s*\(?(?:%|:)?\s*([0-9]+\.?[0-9]*)/i);
    if (divMatch) {
      dividendYield = parseFloat(divMatch[1]);
    }

    return {
      symbol: cleanSym,
      name: companyTitle,
      sector,
      category,
      eps_basic: epsBasic,
      nav_per_share: navps,
      paid_up_capital_mn: paidUpCapitalMn,
      authorized_capital_mn: authorizedCapitalMn,
      dividend_yield: dividendYield,
      audited_period: 'Annual',
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    console.warn(`[AUDITED FUNDAMENTALS SCRAPER] Could not fetch ${cleanSym}: ${err.message}`);
    return null;
  }
}
