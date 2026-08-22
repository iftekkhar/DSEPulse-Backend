/**
 * mendeley_importer.js
 *
 * Imports the Mendeley DSE dataset into staging.db.
 *
 * Source files:
 *   - mendeley/DSE_Data.csv      : 1.52M rows, Trading_Code,Date,Open,High,Low,Close,Volume
 *   - mendeley/Instruments.txt   : 534 instrument codes in the dataset
 *   - mendeley/Instrument_Based/ : Per-symbol CSVs (same schema)
 *
 * Rules (per user requirements):
 *   1. ONLY import symbols that are currently ACTIVE on DSE today
 *      (intersect Mendeley symbols with active_symbols.json)
 *   2. Skip any row with close <= 0, invalid date, or missing symbol
 *   3. Normalize dates to YYYY-MM-DD
 *   4. Source tag: 'MENDELEY'
 *   5. Never overwrite a record that already has source='DSE_SCRAPE'
 *      (live scrape data takes priority over historical dataset)
 */

import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { initStagingDB, stagePriceBatch, stageIndexBatch } from '../db/staging_db.js';
import { loadActiveSymbols } from '../scrapers/company_list_scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMPORTS_DIR = path.join(__dirname, '..', '..', 'data', 'imports');
const MENDELEY_DIR = path.join(IMPORTS_DIR, 'mendeley');
const KAGGLE_DIR   = path.join(IMPORTS_DIR, 'Kaggle');

const MENDELEY_MAIN_CSV = path.join(MENDELEY_DIR, 'DSE_Data.csv');
const MENDELEY_DSEX_CSV = path.join(MENDELEY_DIR, 'Instrument_Based', 'DSEX.csv');
const KAGGLE_BROAD_CSV  = path.join(KAGGLE_DIR, 'Dhaka Stock Exchange Broad Historical Data.csv');

const LOG_FILE = path.join(__dirname, '..', '..', 'data', 'import_log.json');

// ─── DATA SCOPE ───────────────────────────────────────────────────────────────
// Start from DSEX launch date: 2013-01-27 (index available for full period).
// Pre-2013 (DGEN era) is excluded: no index data exists in any source.
const DATA_START_DATE = '2013-01-01';

// ─────────────────────────────────────────────────────────────────────────────
//  DATE NORMALIZER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize various date formats to YYYY-MM-DD.
 * Handles: "2025-04-08", "Jan 30, 2013", "Sep 21, 2020", etc.
 */
function normalizeDate(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/"/g, '');

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "Jan 30, 2013" or "Sep 21, 2020"
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * Clean a numeric string: remove quotes, commas, % signs.
 */
function cleanNum(v) {
  if (v == null || v === '-' || v === '' || v === 'N/A') return null;
  const n = parseFloat(String(v).replace(/[",\s%]/g, ''));
  return isNaN(n) ? null : n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STREAM PARSER — reads large CSVs line by line
// ─────────────────────────────────────────────────────────────────────────────

async function streamParseCSV(filePath, onBatch, { activeSet, batchSize = 2000, indexMode = false, indexLabel = 'DSEX' } = {}) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  let batch = [];
  let totalRows = 0;
  let skipped = 0;
  let imported = 0;

  for await (const line of rl) {
    const rawLine = line.trim();
    if (!rawLine) continue;

    // Parse CSV line (simple split — fields don't contain commas in this dataset)
    const cells = rawLine.split(',').map(c => c.trim().replace(/^"|"$/g, ''));

    if (!headers) {
      headers = cells.map(h => h.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
      continue;
    }

    totalRows++;
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });

    if (indexMode) {
      // Index CSV: columns are Trading_Code,Date,Open,High,Low,Close,Volume
      // OR from Kaggle: Date,Price,Open,High,Low,Vol.,Change%
      const dateRaw   = row['date'] || row[''];
      const closeRaw  = row['close'] || row['price'];
      const openRaw   = row['open'];
      const highRaw   = row['high'];
      const lowRaw    = row['low'];
      const volRaw    = row['volume'] || row['vol.'];

      const trade_date  = normalizeDate(dateRaw);
      const index_value = cleanNum(closeRaw);

      if (!trade_date || !index_value || index_value <= 0) { skipped++; continue; }
      if (trade_date < DATA_START_DATE) { skipped++; continue; } // DSEX era only

      batch.push({
        trade_date,
        index_label: indexLabel,
        index_value,
        index_open:  cleanNum(openRaw),
        index_high:  cleanNum(highRaw),
        index_low:   cleanNum(lowRaw),
        total_volume: cleanNum(volRaw) != null ? Math.round(cleanNum(volRaw)) : null,
        source: 'MENDELEY',
      });
    } else {
      // Price CSV: Trading_Code,Date,Open,High,Low,Close,Volume
      let symbol   = (row['trading_code'] || row['symbol'] || '').toUpperCase().trim();
      
      // Symbol Alias Normalization
      if (symbol === 'AMCLPRAN' || symbol === 'AMCL') symbol = 'AMCL(PRAN)';
      if (symbol === 'KAYQUE' || symbol === 'KAY') symbol = 'KAY&QUE';
      if (symbol === 'NPOLYMAR') symbol = 'NPOLYMER';

      const dateRaw  = row['date'];
      const closeRaw = row['close'];
      const openRaw  = row['open'];
      const highRaw  = row['high'];
      const lowRaw   = row['low'];
      const volRaw   = row['volume'];

      // Skip if not in active symbol set
      if (!symbol || (activeSet && !activeSet.has(symbol))) { skipped++; continue; }

      // Skip pre-2013 rows (DGEN era — no index coverage)
      const dateNorm = normalizeDate(dateRaw);
      if (!dateNorm || dateNorm < DATA_START_DATE) { skipped++; continue; }

      const trade_date = dateNorm;
      const close      = cleanNum(closeRaw);

      if (!trade_date || close == null || close <= 0) { skipped++; continue; }

      batch.push({
        symbol,
        trade_date,
        open:   cleanNum(openRaw),
        high:   cleanNum(highRaw),
        low:    cleanNum(lowRaw),
        close,
        volume: cleanNum(volRaw) != null ? Math.round(cleanNum(volRaw)) : null,
        source: 'MENDELEY',
      });
    }

    if (batch.length >= batchSize) {
      const n = await onBatch(batch);
      imported += n;
      batch = [];
      process.stdout.write(`\r[Import] Processed ${totalRows.toLocaleString()} rows, imported ${imported.toLocaleString()}...`);
    }
  }

  // Final batch
  if (batch.length > 0) {
    const n = await onBatch(batch);
    imported += n;
  }

  process.stdout.write('\n');
  return { totalRows, imported, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN IMPORT FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Import Mendeley DSE_Data.csv into stg_price_history.
 * Filters to ACTIVE symbols only.
 */
export async function importMendeleyPrices() {
  await initStagingDB();

  if (!(await fs.pathExists(MENDELEY_MAIN_CSV))) {
    throw new Error(`Mendeley CSV not found: ${MENDELEY_MAIN_CSV}`);
  }

  // Load active symbols
  const activeSymbols = await loadActiveSymbols();
  if (activeSymbols.length === 0) {
    throw new Error('No active symbols found. Run --fetch-company-list first.');
  }
  const activeSet = new Set(activeSymbols);
  console.log(`[Import] Active symbol filter: ${activeSet.size} symbols`);
  console.log(`[Import] Date filter: ${DATA_START_DATE} → present (DSEX era only, pre-2013 DGEN era excluded)`);
  console.log(`[Import] Importing Mendeley price history: ${MENDELEY_MAIN_CSV}`);

  const stats = await streamParseCSV(
    MENDELEY_MAIN_CSV,
    (batch) => stagePriceBatch(batch),
    { activeSet, batchSize: 2000 }
  );

  console.log(`[Import] ✅ Mendeley Price Import Complete:`);
  console.log(`         Total rows: ${stats.totalRows.toLocaleString()}`);
  console.log(`         Imported:   ${stats.imported.toLocaleString()}`);
  console.log(`         Skipped:    ${stats.skipped.toLocaleString()} (inactive symbols / invalid rows)`);

  return stats;
}

/**
 * Import Mendeley DSEX.csv + Kaggle broad CSV into stg_index_history.
 * Merges both sources, deduplicates by date.
 * Labels: all as 'DSEX' (Mendeley DSEX data starts from 2013).
 * For DGEN data (pre-2013), the Mendeley data uses DSEX label too — 
 * we check the date and apply the correct label.
 */
export async function importIndexHistory() {
  await initStagingDB();
  const log = { mendeley: null, kaggle: null };

  // ── 1. Import Mendeley DSEX.csv (2013+ only) ──────────────────────────────
  if (await fs.pathExists(MENDELEY_DSEX_CSV)) {
    console.log(`[Import] Importing Mendeley DSEX index (from ${DATA_START_DATE}): ${MENDELEY_DSEX_CSV}`);
    const stats = await streamParseCSV(
      MENDELEY_DSEX_CSV,
      (batch) => {
        const labelled = batch.map(r => ({
          ...r,
          index_label: 'DSEX',
          source: 'MENDELEY',
        }));
        return stageIndexBatch(labelled);
      },
      { indexMode: true, indexLabel: 'DSEX', batchSize: 500 }
    );
    log.mendeley = stats;
    console.log(`[Import] ✅ Mendeley DSEX: ${stats.imported} sessions imported.`);
  } else {
    console.warn(`[Import] ⚠️  Mendeley DSEX CSV not found at: ${MENDELEY_DSEX_CSV}`);
  }

  // ── 2. Import Kaggle broad DSEX CSV (supplement for any gaps) ─────────────
  if (await fs.pathExists(KAGGLE_BROAD_CSV)) {
    console.log(`[Import] Importing Kaggle broad DSEX index: ${KAGGLE_BROAD_CSV}`);
    // Kaggle format: "Date","Price","Open","High","Low","Vol.","Change %"
    // Date format:   "Sep 21, 2020"
    const stream = fs.createReadStream(KAGGLE_BROAD_CSV, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let isHeader = true;
    let batch = [];
    let imported = 0;
    let skipped = 0;

    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

    for await (const line of rl) {
      const rawLine = line.trim().replace(/^\uFEFF/, ''); // Strip BOM
      if (!rawLine) continue;

      if (isHeader) {
        isHeader = false;
        continue;
      }

      // Regex split quoted CSV line
      const cells = [];
      const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
      let match;
      while ((match = regex.exec(rawLine)) !== null) {
        if (match.index === regex.lastIndex) regex.lastIndex++;
        cells.push(match[1] !== undefined ? match[1] : match[2]);
      }

      const dateRaw  = cells[0];
      const closeRaw = cells[1];
      const openRaw  = cells[2];
      const highRaw  = cells[3];
      const lowRaw   = cells[4];

      // Parse Kaggle date: "Sep 21, 2020"
      let trade_date = null;
      if (dateRaw) {
        const m = dateRaw.match(/([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})/);
        if (m) {
          const mon = months[m[1].toLowerCase()];
          const day = String(m[2]).padStart(2, '0');
          const yr = m[3];
          trade_date = `${yr}-${mon}-${day}`;
        } else {
          trade_date = normalizeDate(dateRaw);
        }
      }

      const index_value = cleanNum(closeRaw);
      if (!trade_date || !index_value || index_value <= 0) { skipped++; continue; }
      if (trade_date < DATA_START_DATE) { skipped++; continue; }

      batch.push({
        trade_date,
        index_label: 'DSEX',
        index_value,
        index_open: cleanNum(openRaw),
        index_high: cleanNum(highRaw),
        index_low:  cleanNum(lowRaw),
        source: 'KAGGLE',
      });

      if (batch.length >= 500) {
        const n = await stageIndexBatch(batch);
        imported += n;
        batch = [];
      }
    }
    if (batch.length > 0) {
      const n = await stageIndexBatch(batch);
      imported += n;
    }
    log.kaggle = { imported, skipped };
    console.log(`[Import] ✅ Kaggle DSEX: ${imported} sessions imported.`);
  } else {
    console.warn(`[Import] ⚠️  Kaggle broad CSV not found at: ${KAGGLE_BROAD_CSV}`);
  }

  // Save import log
  await fs.outputJson(LOG_FILE, { generated_at: new Date().toISOString(), ...log }, { spaces: 2 });

  return log;
}
