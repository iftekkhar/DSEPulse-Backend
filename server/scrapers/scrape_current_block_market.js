/**
 * Master Block Market Transactions Scraper
 *
 * Ingests daily DSE block market transactions from LankaBD (Tier Two).
 * Captures institutional trades, block volume, turnover value (mn), and min/max block execution prices.
 *
 * Persists directly into `block_market_history` in `data/dse.db`.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { initDB, saveBlockMarketBatch } from '../db.js';
import { numOrNull, positiveNumOrNull } from '../../shared/safe_number.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { DataAuditor } from '../../shared/data_auditor.js';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://lankabd.com/',
};

export async function scrapeBlockMarket({ date = null } = {}) {
  if (!isScraperEnabled('historical.block_market_scraper')) {
    console.log(scraperBlockedMessage('historical.block_market_scraper'));
    return { saved: 0, blocked: true };
  }

  await initDB();
  const sessionDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
  console.log(`\n===============================================================`);
  console.log(`  🏛️ STARTING BLOCK MARKET TRANSACTIONS INGESTION (${sessionDate})`);
  console.log(`===============================================================\n`);

  try {
    const url = 'https://lankabd.com/Home/BlockMarket';
    const res = await axios.get(url, { headers, timeout: 25000 });
    const $ = cheerio.load(res.data);

    // Table 1 corresponds to DSE Block Market Transactions
    const dseTable = $('table').eq(1);
    if (!dseTable || dseTable.length === 0) {
      console.warn('[BlockMarket] No DSE block transactions table found on page.');
      return { saved: 0 };
    }

    const rows = [];
    dseTable.find('tbody tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim().replace(/,/g, '')).get();
      if (cells.length < 6) return;

      const symbol = (cells[0] || '').toUpperCase().trim();
      // numOrNull instead of `parseInt(...) || null`: the `||` form collapses a
      // genuine "0" string to null (0 is falsy), the exact truthy-zero-nulling
      // bug shared/safe_number.js's own rules exist to prevent.
      const quantity = positiveNumOrNull(cells[1]);
      const value_mn = numOrNull(cells[2]);
      const trades = numOrNull(cells[3]);
      const max_price = numOrNull(cells[4]);
      const min_price = numOrNull(cells[5]);

      if (!symbol || symbol === 'TOTAL' || !quantity) return;

      rows.push({
        symbol,
        date: sessionDate,
        quantity,
        value_mn,
        trades,
        max_price,
        min_price,
        source: 'LANKABD'
      });
    });

    console.log(`[BlockMarket] Parsed ${rows.length} institutional block transactions for ${sessionDate}.`);

    // Every scraper audits its output before it reaches a DB write (ARCHITECTURE.md) --
    // this table previously had no DataAuditor gate at all.
    const cleanRows = [];
    const auditErrors = [];
    for (const r of rows) {
      const audit = DataAuditor.auditBlockMarketRecord(r.symbol, [r]);
      if (audit.passed && audit.cleaned.length > 0) {
        cleanRows.push(audit.cleaned[0]);
      } else {
        auditErrors.push(`${r.symbol}: ${audit.errors.join('; ')}`);
      }
    }
    if (auditErrors.length > 0) {
      console.warn(`[BlockMarket] ${auditErrors.length} record(s) skipped by audit:`, auditErrors.slice(0, 10));
    }

    if (cleanRows.length > 0) {
      const savedCount = await saveBlockMarketBatch(cleanRows);
      console.log(`[BlockMarket] ✅ Successfully saved ${savedCount} block records to block_market_history.`);
      return { saved: savedCount, date: sessionDate, rows: cleanRows };
    }

    return { saved: 0, date: sessionDate };
  } catch (err) {
    console.error(`[BlockMarket] Error scraping block market:`, err.message);
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1] || null;
  scrapeBlockMarket({ date: dateArg })
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
