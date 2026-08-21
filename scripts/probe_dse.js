import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function inspectTables() {
  const urls = [
    'https://dsebd.org/dse_close_price.php',
    'https://dsebd.org/dseX_share.php',
    'https://dsebd.org/mkt_depth_3.php'
  ];
  for (const u of urls) {
    try {
      const res = await axios.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, httpsAgent, timeout: 15000 });
      const $ = cheerio.load(res.data);
      console.log(`\nURL: ${u}`);
      $('table').each((ti, tbl) => {
        const trs = $(tbl).find('tr');
        if (trs.length > 5) {
          console.log(`  Table #${ti} has ${trs.length} rows. Class: "${$(tbl).attr('class')}"`);
          const headers = $(trs[0]).find('th, td').map((_, c) => $(c).text().trim()).get();
          console.log(`  Header row:`, JSON.stringify(headers));
          if (trs.length > 1) {
            const row1 = $(trs[1]).find('th, td').map((_, c) => $(c).text().trim()).get();
            console.log(`  Data row 1:`, JSON.stringify(row1));
          }
        }
      });
    } catch (e) {
      console.error('Error for ' + u, e.message);
    }
  }
}

inspectTables();
