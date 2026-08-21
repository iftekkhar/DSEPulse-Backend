import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const API_BASE = process.env.BACKEND_API_URL || 'http://localhost:5001';
const INGEST_KEY = process.env.INGEST_API_KEY || 'dse-pulse-internal-key-2026';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
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
 * Pushes company fundamentals and 20-year statements to backend
 */
export async function publishCompanyFundamentals(symbol, fundamentals, statements = []) {
  try {
    const res = await client.post('/api/ingest/fundamentals', {
      symbol,
      fundamentals,
      statements
    });
    return res.data;
  } catch (err) {
    console.error(`[SYNC PUBLISHER] Failed publishing fundamentals for ${symbol}: ${err.response?.data?.error || err.message}`);
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
