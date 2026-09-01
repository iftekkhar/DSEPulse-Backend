import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbRun, dbAll } from '../../db.js';
import { fetchWithRetry, runBatched } from '../../../shared/dse_http_client.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../../shared/scraper_registry.js';
import { DataAuditor } from '../../../shared/data_auditor.js';
import { numOrNull } from '../../../shared/safe_number.js';
import { backupDatabaseBeforeRiskyRun } from '../../db/backup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const SYMBOLS_FILE = path.join(DATA_DIR, 'active_symbols.json');

export async function fetchActiveSymbolsFromDSE() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const startStr = monthAgo.toISOString().slice(0, 10);
  const endStr = yesterday.toISOString().slice(0, 10);

  const url = `https://www.dsebd.org/day_end_archive.php?startDate=${startStr}&endDate=${endStr}&inst=${encodeURIComponent('All Instrument')}&archive=data`;
  console.log(`[CurrentScraper/Roster] Fetching 30-day traded-instrument archive: ${startStr} -> ${endStr}`);

  const res = await fetchWithRetry(url, { timeout: 45000, attempts: 3, backoffMs: 3000 });
  const $ = cheerio.load(res.data);
  const symbols = new Set();

  $('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const cellVals = $(row).find('td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (cellVals.length < 8) return;

      const dateRaw = cellVals[1];
      if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return;

      const symbol = cellVals[2].toUpperCase().trim();
      if (!symbol || symbol.length > 20) return;

      symbols.add(symbol);
    });
  });

  return Array.from(symbols);
}

export async function fetchCompanyDetails(symbol) {
  const url = `https://www.dsebd.org/displayCompany.php?name=${symbol}`;
  try {
    const res = await fetchWithRetry(url, { timeout: 20000, attempts: 3, backoffMs: 2000 });
    const $ = cheerio.load(res.data);

    let name = null, sector = null, category = null, totalShares = null, faceValue = null;

    $('h2').each((_, el) => {
      if (name) return;
      const t = $(el).text().trim();
      if (t.startsWith('Company Name:')) {
        name = t.replace(/^Company Name:\s*/i, '').trim() || null;
      }
    });

    $('table tr').each((_, row) => {
      const cells = $(row).find('td, th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].toLowerCase();
        const value = cells[i + 1];
        if (!value) continue;
        if (label === 'sector') sector = value;
        else if (label.includes('category')) category = value.charAt(0).toUpperCase() || null;
        else if (label.includes('face value') || label.includes('par value')) {
          faceValue = numOrNull(value);
        } else if (label.includes('total share') || label.includes('outstanding securities')) {
          totalShares = numOrNull(value);
        }
      }
    });

    return { name, sector, category, face_value: faceValue, total_shares: totalShares };
  } catch {
    return { name: null, sector: null, category: null, face_value: null, total_shares: null };
  }
}

export async function scrapeCompanyList({ fetchDetails = false, resume = true } = {}) {
  if (!isScraperEnabled('historical.company_list_scraper')) {
    console.log(scraperBlockedMessage('historical.company_list_scraper'));
    return { count: 0, symbols: [], blocked: true };
  }
  const now = new Date().toISOString();

  const activeSymbols = await fetchActiveSymbolsFromDSE();
  console.log(`[CurrentScraper/Roster] Found ${activeSymbols.length} active instruments traded on DSE in last 30 days.`);

  // Pre-flight backup before the full-sync reset below (ARCHITECTURE.md Known
  // Incident #8 happened on exactly this write path: an unconditional
  // is_active=0 reset followed by re-marking active symbols, where a bad
  // detail-field audit rejection once collaterally deactivated a real,
  // actively-traded symbol). Best-effort -- never blocks the sync itself.
  await backupDatabaseBeforeRiskyRun('pre-company-list-sync');

  await dbRun(`UPDATE company_list SET is_active = 0`);

  let symbolsToFetch = activeSymbols.slice();
  if (fetchDetails && resume) {
    const existingRows = await dbAll(`SELECT symbol FROM company_list WHERE name IS NOT NULL`);
    const existingSet = new Set(existingRows.map(r => r.symbol));
    const before = symbolsToFetch.length;
    symbolsToFetch = symbolsToFetch.filter(s => !existingSet.has(s));
    if (before > symbolsToFetch.length) {
      console.log(`[CurrentScraper/Roster] Resume check: ${before - symbolsToFetch.length} symbols already have details, ${symbolsToFetch.length} remaining.`);
    }
  }

  const detailsMap = new Map();
  if (fetchDetails && symbolsToFetch.length > 0) {
    console.log(`[CurrentScraper/Roster] Fetching details for ${symbolsToFetch.length} symbols (concurrency 6)...`);
    let processed = 0;
    await runBatched(symbolsToFetch, async (symbol) => {
      const details = await fetchCompanyDetails(symbol);
      detailsMap.set(symbol, details);
      processed++;
      if (processed % 20 === 0) {
        console.log(`[CurrentScraper/Roster] Processed ${processed}/${symbolsToFetch.length} detail fetches...`);
      }
    }, { batchSize: 6, delayMs: 250 });
  }

  const results = [];
  let blockedCount = 0;
  for (const symbol of activeSymbols) {
    const details = detailsMap.get(symbol) || { name: null, sector: null, category: null, face_value: null, total_shares: null };

    const audit = DataAuditor.auditCompanyListRecord({ symbol, ...details });
    if (!audit.passed) {
      console.warn(`[CurrentScraper/Roster] BLOCKED ${symbol} detail fields by audit:`, audit.errors);
      blockedCount++;
      await dbRun(`
        INSERT INTO company_list (symbol, name, sector, category, face_value, total_shares, is_active, fetched_at, source)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, 1, ?, 'DSE_SCRAPE')
        ON CONFLICT(symbol) DO UPDATE SET
          is_active=1,
          fetched_at=excluded.fetched_at
      `, [symbol, now]);
      results.push({ symbol, name: null, sector: null, category: null, face_value: null, total_shares: null, is_active: 1 });
      continue;
    }
    const clean = audit.cleaned;

    await dbRun(`
      INSERT INTO company_list (symbol, name, sector, category, face_value, total_shares, is_active, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'DSE_SCRAPE')
      ON CONFLICT(symbol) DO UPDATE SET
        name=COALESCE(excluded.name, company_list.name),
        sector=COALESCE(excluded.sector, company_list.sector),
        category=COALESCE(excluded.category, company_list.category),
        face_value=COALESCE(excluded.face_value, company_list.face_value),
        total_shares=COALESCE(excluded.total_shares, company_list.total_shares),
        is_active=1,
        fetched_at=excluded.fetched_at
    `, [clean.symbol, clean.name, clean.sector, clean.category, clean.face_value, clean.total_shares, now]);

    results.push({ symbol, ...details, is_active: 1 });
  }
  if (blockedCount > 0) {
    console.warn(`[CurrentScraper/Roster] ${blockedCount} symbol(s) blocked by audit this run.`);
  }

  const activeList = results.map(r => r.symbol).sort();
  await fs.outputJson(SYMBOLS_FILE, {
    generated_at: now,
    count: activeList.length,
    symbols: activeList
  }, { spaces: 2 });

  console.log(`[CurrentScraper/Roster] ✅ ${results.length} active symbols saved in main DB company_list & ${SYMBOLS_FILE}`);
  return { count: results.length, symbols: activeList };
}

export async function loadActiveSymbols() {
  if (await fs.pathExists(SYMBOLS_FILE)) {
    const data = await fs.readJson(SYMBOLS_FILE);
    return data.symbols || [];
  }
  const rows = await dbAll(`SELECT symbol FROM company_list WHERE is_active = 1 ORDER BY symbol`);
  return rows.map(r => r.symbol);
}
