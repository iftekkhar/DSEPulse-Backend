import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const API_BASE = process.env.BACKEND_API_URL || 'http://localhost:5001';
// No fallback: this key must match the backend's INGEST_API_KEY exactly, and a
// hardcoded default here was the other half of the hardcoded-key exposure (the
// backend's matching fallback has been removed too). Fail loudly instead of
// silently sending a guessable key that will just get 403'd -- or worse, would
// have worked, since it used to match the server's own default.
if (!process.env.INGEST_API_KEY) {
  console.error('[FATAL] INGEST_API_KEY is not set. Refusing to publish to the ingest API with a default/guessable key.');
  process.exit(1);
}
const INGEST_KEY = process.env.INGEST_API_KEY;

// keepAlive: false -- manual_promoter.js loads and groups the ENTIRE staging
// price-history table (900K+ rows across 395 symbols) into memory between the
// DSEX publish call and the first per-symbol publish call, a multi-second gap.
// With Node's default keep-alive agent, that gap is long enough for the server
// (or an OS-level idle-connection timeout) to close the pooled socket -- the
// client then reuses the now-dead socket for the next request and gets
// ECONNRESET. Confirmed via direct reproduction: identical calls succeed every
// time back-to-back, but fail after that data-loading gap. Disabling keep-alive
// forces a fresh connection per request, which costs a bit of setup latency but
// eliminates the stale-socket race outright.
const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  httpAgent: new http.Agent({ keepAlive: false }),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${INGEST_KEY}`
  }
});

/**
 * Pushes live scraped market snapshot to backend
 */
export async function publishLiveSnapshot(snapshot) {
  try {
    const res = await client.post('/api/ingest/live', snapshot);
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing live snapshot: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}

/**
 * Pushes 20-year audited statements to backend -- fundamentals_history is the
 * only fundamentals table main DB has now (company_fundamentals dropped
 * 2026-08-23, "current" is derived server-side from the latest fiscal_year
 * row, so there's no separate current-snapshot object to send here anymore).
 */
export async function publishCompanyFundamentals(symbol, statements = []) {
  try {
    const res = await client.post('/api/ingest/fundamentals', {
      symbol,
      statements
    });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing fundamentals for ${symbol}: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}

/**
 * Pushes the full company/instrument roster to backend's company_list.
 */
export async function publishCompanyList(records = []) {
  try {
    const res = await client.post('/api/ingest/companylist', { records });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing company list: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}

/**
 * Pushes current shareholding snapshots (current + prior-disclosed-month
 * only, see stg_shareholding_current's own comment) to backend.
 */
export async function publishShareholding(records = []) {
  try {
    const res = await client.post('/api/ingest/shareholding', { records });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing shareholding: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}

/**
 * Pushes historical closing price series for a symbol
 */
export async function publishStockHistory(symbol, history = []) {
  try {
    const res = await client.post('/api/ingest/history', {
      symbol,
      history
    });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing history for ${symbol}: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}

/**
 * Pushes 20-year DSEX macro index history
 */
export async function publishDSEXHistory(records = []) {
  try {
    const res = await client.post('/api/ingest/dsex', { records });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing DSEX history: ${err.response?.data?.error || err.message}`);
    throw err;
  }
}
