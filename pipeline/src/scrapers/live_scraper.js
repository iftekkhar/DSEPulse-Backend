import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

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

    // Parse main trading table
    $('table.table-bordered tbody tr, table.shares-table tr').each((_, row) => {
      const cols = $(row).find('td').map((_, el) => $(el).text().trim()).get();
      if (cols.length >= 8) {
        const symbol = cols[1]?.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
        if (!symbol || symbol === 'TRADING_CODE' || symbol === 'CODE') return;

        const ltp = parseFloat(cols[2]?.replace(/,/g, '')) || 0;
        const high = parseFloat(cols[3]?.replace(/,/g, '')) || ltp;
        const low = parseFloat(cols[4]?.replace(/,/g, '')) || ltp;
        const close = parseFloat(cols[5]?.replace(/,/g, '')) || ltp;
        const ycp = parseFloat(cols[6]?.replace(/,/g, '')) || ltp;
        const change = parseFloat(cols[7]?.replace(/,/g, '')) || (ltp - ycp);
        const changePercent = ycp > 0 ? Number(((change / ycp) * 100).toFixed(2)) : 0;
        const volume = parseInt(cols[9]?.replace(/,/g, ''), 10) || parseInt(cols[8]?.replace(/,/g, ''), 10) || 0;
        const valueMn = parseFloat(cols[10]?.replace(/,/g, '')) || 0;

        if (ltp > 0) {
          if (change > 0) advancing++;
          else if (change < 0) declining++;
          else unchanged++;

          totalTurnoverMn += valueMn;
          totalVolume += volume;

          stocks.push({
            symbol,
            ltp,
            high,
            low,
            close,
            ycp,
            change: Number(change.toFixed(2)),
            changePercent,
            volume,
            valueMn: Number(valueMn.toFixed(2)),
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
