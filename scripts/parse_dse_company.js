import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function inspectTables() {
  const res = await axios.get('https://dsebd.org/displayCompany.php?name=BRACBANK', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent
  });
  const $ = cheerio.load(res.data);
  $('table').each((i, tbl) => {
    const text = $(tbl).text();
    if (text.includes('NAV Per Share') || text.includes('Audited')) {
      console.log(`\n--- Table #${i} ---`);
      $(tbl).find('tr').each((ri, tr) => {
        const cols = $(tr).find('th, td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
        console.log(`Row ${ri}:`, JSON.stringify(cols));
      });
    }
  });
}

inspectTables();
