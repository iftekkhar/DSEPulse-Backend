import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { numOrNull } from '../../../shared/safe_number.js';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const DSE_LIVE_URL = 'https://www.dsebd.org/latest_share_price_scroll_l.php';
const DSE_HOMEPAGE_URL = 'https://www.dsebd.org/index.php';

/**
 * Scrapes DSE live market prices and market breadth
 */
export async function scrapeLiveMarketSnapshot() {
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.slice(0, 10);

  try {
    const res = await axios.get(DSE_LIVE_URL, {
      httpsAgent,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(res.data);
    const stocks = [];
    let advancing = 0;
    let declining = 0;
    let unchanged = 0;
    let totalTurnoverMn = 0;
    let totalVolume = 0;

    // Every column is parsed independently via the canonical numOrNull: a
    // failed/missing parse stays null, never a copy of a different column or a
    // hardcoded 0. The old version defaulted high/low/ycp to ltp on parse
    // failure -- for ycp specifically, that silently fabricates a 0% change
    // (ltp - ltp = 0), the same bug already found and fixed elsewhere in this
    // project, just via `|| ltp` instead of `?? close`.
    const parseNum = numOrNull;

    // Parse main trading table
    $('table.table-bordered tbody tr, table.shares-table tr').each((_, row) => {
      const cols = $(row).find('td').map((_, el) => $(el).text().trim()).get();
      if (cols.length >= 8) {
        const symbol = cols[1]?.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
        if (!symbol || symbol === 'TRADING_CODE' || symbol === 'CODE') return;

        const ltp = parseNum(cols[2]);
        const high = parseNum(cols[3]);
        const low = parseNum(cols[4]);
        const close = parseNum(cols[5]);
        const ycp = parseNum(cols[6]);
        const change = parseNum(cols[7]) ?? ((ltp !== null && ycp !== null) ? (ltp - ycp) : null);
        const changePercent = (change !== null && ycp !== null && ycp > 0) ? ((change / ycp) * 100) : null;
        const volume = parseNum(cols[9], true) ?? parseNum(cols[8], true);
        const valueMn = parseNum(cols[10]);

        if (ltp !== null && ltp > 0) {
          if (change !== null) {
            if (change > 0) advancing++;
            else if (change < 0) declining++;
            else unchanged++;
          }

          // Sum-of-possibly-missing-values for a market-wide aggregate: an unknown
          // per-stock volume/turnover contributes 0 to the total (standard
          // aggregation practice, already established elsewhere in this project) --
          // not the same as writing a fabricated 0 into that stock's own record.
          totalTurnoverMn += valueMn ?? 0;
          totalVolume += volume ?? 0;

          stocks.push({
            symbol,
            ltp,
            high,
            low,
            close,
            ycp,
            change: change !== null ? Number(change.toFixed(2)) : null,
            changePercent: changePercent !== null ? Number(changePercent.toFixed(2)) : null,
            volume,
            valueMn: valueMn !== null ? Number(valueMn.toFixed(2)) : null,
            tradeDate: dateStr
          });
        }
      }
    });

    // Scrape homepage for official DSEX index benchmark if available
    let dsexIndex = null;
    try {
      const homeRes = await axios.get(DSE_HOMEPAGE_URL, { httpsAgent, timeout: 10000 });
      const $home = cheerio.load(homeRes.data);
      const dsexText = $home('td:contains("DSEX Index"), span:contains("DSEX")').first().parent().text();
      const match = dsexText.match(/([0-9]{1,2},[0-9]{3}\.[0-9]{2}|[0-9]{4,5}\.[0-9]{2})/);
      if (match) {
        dsexIndex = parseFloat(match[1].replace(/,/g, ''));
      }
    } catch {
      // DSEX fallback
    }

    const marketBreadth = {
      date: dateStr,
      dsexIndex, // null if the live homepage scrape failed -- never a guessed fallback value
      advancing,
      declining,
      unchanged,
      totalIssues: advancing + declining + unchanged,
      turnoverMn: Number(totalTurnoverMn.toFixed(2)),
      totalVolume
    };

    return {
      timestamp,
      date: dateStr,
      totalCount: stocks.length,
      marketBreadth,
      stocks
    };
  } catch (err) {
    console.error(`[LIVE SCRAPER ERROR] Failed scraping DSE live prices: ${err.message}`);
    throw err;
  }
}
