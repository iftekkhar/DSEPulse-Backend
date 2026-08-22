/**
 * dse_http_client.js
 *
 * Shared scraping utility used by both `server/` and `pipeline/` scrapers. Extracted from
 * the retry/batching patterns already proven safe against dsebd.org in this codebase
 * (pipeline/src/scrapers/fundamentals_scraper.js's retry loop, server/scrapers/
 * audited_eps_scraper.js's Promise.all batching) so every scraper gets the same
 * reliability behavior instead of copy-pasted (and inconsistently copy-pasted) versions.
 *
 * fetchWithRetry NEVER returns a default value on failure -- it throws after exhausting
 * attempts. Callers decide what "no data" means for their own record (null, skip, etc.);
 * this module must never silently manufacture a fallback number.
 */
import axios from 'axios';
import https from 'https';

export const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export const DSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Referer': 'https://www.dsebd.org/',
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * GET a URL with retry + backoff. Throws (never returns a default) once attempts
 * are exhausted -- callers must handle the rejection explicitly.
 */
export async function fetchWithRetry(url, { headers = DSE_HEADERS, timeout = 25000, attempts = 3, backoffMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, { headers, httpsAgent, timeout });
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }
  }
  throw lastErr;
}

/**
 * Runs workerFn over items in fixed-size concurrent batches with a delay between
 * batches. This is the house concurrency style (batch=6, delay=250ms is the default,
 * already proven safe against dsebd.org) -- prefer this over sequential-with-long-delay
 * loops for new/refactored scrapers.
 */
export async function runBatched(items, workerFn, { batchSize = 6, delayMs = 250 } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item, idx) => workerFn(item, i + idx)));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(delayMs);
  }
  return results;
}
