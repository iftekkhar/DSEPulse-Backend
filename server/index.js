import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import * as cheerio from 'cheerio';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDB,
  saveDailyClosingToDB,
  saveSymbolHistoryBulk,
  saveFundamentalsBulkDelta,
  saveShareholdingCurrent,
  getShareholding,
  getUserWatchlist,
  addToUserWatchlist,
  removeFromUserWatchlist,
  mergeUserWatchlist,
  saveDSEXDailyClosing,
  pruneOrphanedDSEXRows,
  pruneOrphanedPriceHistoryRows,
  saveCompanyList,
  getDSEXHistoricalTimeline,
  getAllStocksFromDB,
  getAllFundamentalsMap,
  getHistoricalTimeline,
  getDetailedHistoricalAnalysis,
  getCompanyFundamentalsHistory,
  getScreenerFlags,
  getSectorPerformance,
  invalidateAnalysisCache,
  dbRun,
  dbAll
} from './db.js';
import { scrapeCompanyAuditedFinancials } from './scrapers/audited_eps_scraper.js';
import { DataAuditor } from '../shared/data_auditor.js';
import { isScraperEnabled, scraperBlockedMessage, assertNoConflictingScrapers, setRuntimeOverride } from '../shared/scraper_registry.js';
import { numOrNull } from '../shared/safe_number.js';
import { fetchWithRetry } from '../shared/dse_http_client.js';
import {
  verifyGoogleIdToken,
  upsertUserFromGoogle,
  createSession,
  destroySession,
  getSessionUser,
  requireUserAuth,
  requireAdminAuth,
  isAdminEmail,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS
} from './auth.js';
import { isEntitled, redeemPromoCode } from './entitlements.js';
import { attachEntitlement, requirePremiumAuth } from './gating.js';
import { filterRowsByDateField, limitToLatestFiscalYear, applyDeepDiveGate, buildLockedMeta } from '../shared/gating_logic.js';
import { stripInternalFields } from '../shared/response_shaping.js';
import { initiatePayment, verifyAndGrant, FRONTEND_RESULT_URL } from './payments.js';
import { PLANS, FREE_WINDOW_DAYS } from '../shared/plans.js';
import { getAllSettings, setSettingOverride } from '../shared/app_settings.js';
import { createAdminRouter } from './admin_routes.js';
import { generateDeepDiveOgImage } from './og_image.js';

// Refuses to boot if this process and pipeline/src/scheduler.js would both be
// writing the same 15:30 BST closing snapshot -- see assertNoConflictingScrapers().
assertNoConflictingScrapers();

let cron;
try {
  cron = await import('node-cron');
  cron = cron.default;
} catch (e) {
  cron = null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS: session cookies (added 2026-08-23 for Google-auth'd sessions) require
// `credentials: true` -- the CORS spec forbids combining that with a wildcard
// origin (browsers reject Access-Control-Allow-Origin: * alongside
// Access-Control-Allow-Credentials: true), so the previous origin: '*' had to
// become an explicit allowlist. FRONTEND_ORIGINS is a comma-separated env var
// (production dashboard URL(s)); localhost dev ports are always allowed so
// local frontend dev keeps working without extra config.
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
const configuredOrigins = (process.env.FRONTEND_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEV_ORIGINS, ...configuredOrigins]);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header (server-to-server calls, curl, the pipeline promoter)
    // -- allow; those never carry cookies and aren't the thing this check
    // protects against. The literal string "null" is a separate, real case:
    // browsers send Origin: null (not an absent header) for certain
    // cross-origin redirect chains -- confirmed live 2026-08-24, this is
    // exactly what SSLCommerz's hosted checkout page sends when it redirects
    // back to /api/payments/callback after a sandbox transaction, and it was
    // being rejected here (falls through !origin since the string "null" is
    // truthy), taking down the entire payment success/fail/cancel flow. Safe
    // to allow for the same reason as a missing origin: an opaque/"null"
    // origin can't read a cross-origin response either way, and the actual
    // payment is always re-verified server-side against SSLCommerz's own API
    // (see server/payments.js), never trusted from this callback alone.
    if (!origin || origin === 'null' || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not in FRONTEND_ORIGINS allowlist`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control', 'Accept'],
  credentials: true
};
app.use(cors(corsOptions));

// Gzip/Brotli Compression & Body Parsing
app.use(compression());
app.use(express.json({ limit: '10mb' }));
// SSLCommerz posts its success/fail/cancel/ipn callbacks (POST
// /api/payments/callback) as standard application/x-www-form-urlencoded --
// express.json() above only parses application/json and silently leaves
// req.body undefined for any other content type, which crashed every real
// callback (confirmed live 2026-08-24 via an actual sandbox transaction:
// "Cannot read properties of undefined (reading 'tran_id')").
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Rate limiting (2026-08-23, part of the premium-tier security posture --
// see ARCHITECTURE.md / the approved plan's Security section for what this
// is and isn't meant to do: it raises the cost of bulk scraping/abuse, it
// doesn't and can't make scraping "impossible" -- nothing on the web can).
// General: generous enough that no real user of this app should ever hit
// it (this is a dashboard people click around in, not a high-frequency
// polling client). Auth/payments: much tighter, since those are the routes
// most worth throttling against automated abuse specifically.
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests -- please slow down.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts -- please try again later.' },
});
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts -- please try again later.' },
});
app.use('/api', generalApiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/payments/initiate', paymentLimiter);

// Global JSON Content-Type Header Enforcement for /api routes
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  next();
});

// In-Memory Fast Cache for Stocks API
let cachedStocks = null;
let lastStocksFetchTime = 0;
const STOCKS_CACHE_TTL = 15000; // 15 seconds

export function invalidateStocksCache() {
  cachedStocks = null;
  lastStocksFetchTime = 0;
  invalidateAnalysisCache();
}

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.ensureDirSync(DATA_DIR);
// latest.json is a live zero-fail fallback (see getAllStocksFromDB in db.js) --
// written here, read there if SQLite ever returns 0 rows. history.json and
// fundamentals.json were declared but never written or read anywhere --
// removed as dead code (2026-08-22).
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const SYMBOLS_FILE = path.join(__dirname, 'symbols.json');

// Tracking runtime job statuses
const jobStatusRegistry = {
  job1: {
    name: 'Official Daily Closing Prices Scraper',
    schedule: 'Sun-Thu @ 15:30 BST',
    target: 'price_history (SQLite)',
    lastRun: null,
    status: 'Ready',
    recordsIngested: 0
  },
  job2: {
    name: 'Live Intraday Ticker & Market Depth',
    schedule: 'On-Demand (Sync Button)',
    target: 'RAM / sessionStorage (0 DB Writes)',
    lastRun: null,
    status: 'Ready'
  },
  job3: {
    name: 'Audited Fundamental Disclosures Crawler',
    schedule: 'Daily Sun-Thu @ 16:00 BST',
    target: 'fundamentals_history (Provisional rows, SQLite Smart Delta)',
    lastRun: null,
    status: 'Ready',
    updatedCount: 0,
    skippedCount: 0
  }
};

// No hardcoded symbol-list fallback: if both symbols.json and the DB read
// fail, returning a fixed 8-symbol list would silently narrow whatever calls
// this to a tiny, stale slice of the real ~639-symbol universe with no
// indication anything was wrong -- the same fabrication-adjacent failure mode
// as a hardcoded data value, just for "which rows to touch" instead of "what
// value to write". Empty means the caller must fail loud instead of guessing.
async function loadSymbols() {
  try {
    if (await fs.pathExists(SYMBOLS_FILE)) {
      const txt = await fs.readFile(SYMBOLS_FILE, 'utf8');
      const s = JSON.parse(txt);
      if (Array.isArray(s) && s.length) return s.map(x => String(x).toUpperCase().trim());
    }
  } catch (err) {
    console.warn('Failed to read symbols.json', err.message);
  }
  const dbStocks = await getAllStocksFromDB().catch(() => []);
  if (dbStocks.length > 0) return dbStocks.map(s => s.symbol);
  return [];
}

// -------------------------------------------------------------
// 1. RAW DSE SCRAPERS (dsebd.org)
// -------------------------------------------------------------

// Scrape official closing price table from dsebd.org/dse_close_price.php
export async function fetchDSEClosingPrices() {
  try {
    // Production's single Sun-Thu 15:30 BST run for this data -- retried with
    // backoff (not a one-shot axios.get) so a single transient network blip
    // doesn't get misreported as "Market Holiday / Off-hours" below.
    const res = await fetchWithRetry('https://dsebd.org/dse_close_price.php', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      attempts: 3,
      backoffMs: 2000
    });

    const $ = cheerio.load(res.data);
    const records = [];
    const rows = $('table.table-bordered tr, table tr');

    rows.each((i, tr) => {
      const cols = $(tr).find('td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
      if (cols.length >= 4) {
        const symbol = cols[1].toUpperCase().trim();
        const close = parseFloat(cols[2].replace(/,/g, ''));
        const ycp = parseFloat(cols[3].replace(/,/g, ''));
        // No 0 fallbacks: a column this row didn't have (or that failed to parse)
        // stays null -- this feeds the permanent daily closing history, where a
        // fabricated 0 volume/value/change is indistinguishable from a real one.
        const high = cols[4] ? parseFloat(cols[4].replace(/,/g, '')) : null;
        const low = cols[5] ? parseFloat(cols[5].replace(/,/g, '')) : null;
        const volume = cols[6] ? parseInt(cols[6].replace(/,/g, ''), 10) : null;
        const value = cols[7] ? parseFloat(cols[7].replace(/,/g, '')) : null;

        if (symbol && !isNaN(close) && close > 0) {
          const hasYcp = !isNaN(ycp) && ycp > 0;
          const change = hasYcp ? Number((close - ycp).toFixed(2)) : null;
          const changePercent = hasYcp ? Number(((change / ycp) * 100).toFixed(2)) : null;
          records.push({
            symbol,
            close,
            closePrice: close,
            ycp: hasYcp ? ycp : null,
            open: hasYcp ? ycp : null,
            high: !isNaN(high) ? high : null,
            low: !isNaN(low) ? low : null,
            change,
            changePercent,
            volume: !isNaN(volume) ? volume : null,
            value: !isNaN(value) ? value : null
          });
        }
      }
    });

    console.log(`[DSE] Scraped ${records.length} official closing prices from dsebd.org`);
    return records;
  } catch (err) {
    console.warn('[DSE] Error fetching closing prices from dsebd.org:', err.message);
    return [];
  }
}

// Scrape live intraday ticker snapshot from dsebd.org
export async function fetchDSELiveTicker() {
  try {
    const urls = [
      'https://dsebd.org/dseX_share.php',
      'https://dsebd.org/mkt_depth_3.php'
    ];
    const map = new Map();

    for (const url of urls) {
      try {
        const res = await fetchWithRetry(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 12000,
          attempts: 3,
          backoffMs: 1500
        });
        const $ = cheerio.load(res.data);
        $('tr').each((_, tr) => {
          const text = $(tr).text().replace(/\s+/g, ' ').trim();
          const match = text.match(/([A-Z0-9_-]{2,16})\s+([\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)%/);
          if (match) {
            const symbol = match[1].toUpperCase().trim();
            const ltp = parseFloat(match[2]);
            const change = parseFloat(match[3]);
            const changePercent = parseFloat(match[4]);
            if (symbol && !isNaN(ltp) && ltp > 0 && !map.has(symbol)) {
              map.set(symbol, { symbol, ltp, change, changePercent });
            }
          }
        });
        if (map.size > 50) break;
      } catch (e) {
        // Continue to next mirror url
      }
    }

    console.log(`[DSE] Scraped ${map.size} live market prices from dsebd.org`);
    return Array.from(map.values());
  } catch (err) {
    console.warn('[DSE] Live ticker scrape notice:', err.message);
    return [];
  }
}

// Scrape individual company fundamentals from official DSE page
// Scrape macro market breadth & DSEX index from dsebd.org homepage
export async function fetchMarketBreadthFromDSE() {
  try {
    const res = await fetchWithRetry('https://dsebd.org/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 12000,
      attempts: 3,
      backoffMs: 1500
    });

    const $ = cheerio.load(res.data);
    // Every field starts null, not 0 -- 0 asserts "confirmed zero", which is wrong
    // for a field this function never even attempts to extract (totalTrades,
    // totalVolume have no regex below) and equally wrong for one whose regex just
    // didn't match this time. Only a field this function actually parsed off the
    // page gets a real number.
    const breadth = {
      advancing: null,
      declining: null,
      unchanged: null,
      totalTrades: null,
      totalVolume: null,
      totalValueMn: null,
      dsexIndex: null
    };

    const text = $('body').text();

    // Extract DSEX Index
    const dsexMatch = text.match(/DSEX\s+([\d,.]+)/i);
    if (dsexMatch) breadth.dsexIndex = parseFloat(dsexMatch[1].replace(/,/g, ''));

    // Extract Advances, Declines, Unchanged
    const advMatch = text.match(/Issues\s+Advanced[:\s]+(\d+)/i) || text.match(/Advanced[:\s]+(\d+)/i);
    if (advMatch) breadth.advancing = parseInt(advMatch[1], 10);

    const decMatch = text.match(/Issues\s+Declined[:\s]+(\d+)/i) || text.match(/Declined[:\s]+(\d+)/i);
    if (decMatch) breadth.declining = parseInt(decMatch[1], 10);

    const unchMatch = text.match(/Issues\s+Unchanged[:\s]+(\d+)/i) || text.match(/Unchanged[:\s]+(\d+)/i);
    if (unchMatch) breadth.unchanged = parseInt(unchMatch[1], 10);

    // Extract Turnover Value
    const valMatch = text.match(/Total\s+Value\s+\(mn\)[:\s]+([\d,.]+)/i) || text.match(/Turnover[:\s]+([\d,.]+)\s+mn/i);
    if (valMatch) breadth.totalValueMn = parseFloat(valMatch[1].replace(/,/g, ''));

    // totalTrades / totalVolume: no extraction pattern exists for these on this
    // page today -- they stay null (honest "not available") rather than a
    // permanent fabricated 0. A real extractor can be added later if/when a
    // reliable source pattern for them is found.

    return breadth;
  } catch (err) {
    console.warn('[DSE] Breadth scrape notice:', err.message);
    return null;
  }
}

// -------------------------------------------------------------
// 2. THE 4 MASTER AUTOMATION JOBS
// -------------------------------------------------------------

// JOB 1: Official Daily Closing Prices Scraper (Saves to SQLite price_history)
export async function runJob1ClosingPrices() {
  if (!isScraperEnabled('server.closing_prices')) {
    console.log(scraperBlockedMessage('server.closing_prices'));
    jobStatusRegistry.job1.status = 'Disabled (see shared/scraper_registry.js)';
    return { success: false, blocked: true };
  }
  console.log('[JOB 1] Starting Official Daily Closing Prices Ingestion...');
  jobStatusRegistry.job1.status = 'Running';

  try {
    const records = await fetchDSEClosingPrices();
    if (records.length === 0) {
      jobStatusRegistry.job1.status = 'No records found (Market Holiday / Off-hours)';
      return { success: false, count: 0 };
    }

    const fundamentalsMap = await getAllFundamentalsMap();
    const todayDhakaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

    // Enrich with dynamic Daily P/E calculation
    const enrichedRecords = records.map(r => {
      const fund = fundamentalsMap[r.symbol] || {};
      const eps = fund.eps !== null && fund.eps > 0 ? Number(fund.eps) : null;
      const dailyPe = eps ? Number((r.close / eps).toFixed(2)) : (fund.peBasic ?? null);
      return {
        ...r,
        pe: dailyPe
      };
    });

    // Audit gate: nothing reaches saveDailyClosingToDB without passing this first.
    const priceAudit = DataAuditor.auditPriceHistory('JOB1_CLOSING_PRICES', enrichedRecords);
    if (!priceAudit.passed) {
      jobStatusRegistry.job1.status = `Blocked by audit: ${priceAudit.errors.length} errors`;
      console.error('[JOB 1] BLOCKED by audit:', priceAudit.errors);
      return { success: false, error: 'Audit failed', errors: priceAudit.errors };
    }

    // Tier 1 -- a live, direct scrape of DSE's own official closing-price page
    // (not a per-record value; every row from this job shares the same source).
    const taggedRecords = priceAudit.cleaned.map(r => ({ ...r, source: 'DSE_LIVE_CLOSING' }));
    const savedCount = await saveDailyClosingToDB(taggedRecords, todayDhakaStr);

    // Compute & Append Official Daily Closing Macro Breadth & DSEX to 20-Year dsex_market_history
    let advancing = 0, declining = 0, unchanged = 0, totalVal = 0, totalVol = 0;
    for (const r of records) {
      // `r.ycp || r.close` here would compare close > close (always false) for any
      // record with a genuinely missing ycp, silently sorting it into "unchanged"
      // -- fabricating "no price movement" for a stock whose real prior close
      // simply wasn't scraped. Only classify when ycp is actually known.
      const hasYcp = r.ycp !== null && r.ycp !== undefined;
      if (hasYcp) {
        if (r.close > r.ycp) advancing++;
        else if (r.close < r.ycp) declining++;
        else unchanged++;
      }
      // Sum-of-possibly-missing-values for a market-wide total: an unknown
      // per-stock value/volume contributes 0 to the aggregate (standard practice),
      // not a fabricated 0 written into that stock's own record.
      totalVal += numOrNull(r.value) ?? 0;
      totalVol += numOrNull(r.volume) ?? 0;
    }

    const liveBreadth = await fetchMarketBreadthFromDSE();
    // No hardcoded fallback numbers -- if a real value isn't available from either the
    // scraped closing records or the live breadth scrape, persist null, not a guess.
    // totalVal/totalVol are our own real computed sums over the actually-scraped
    // records, not a "fallback" needing arbitration against liveBreadth -- use them
    // directly rather than the old `totalVol || liveBreadth?.totalVolume || null`
    // chain, which could silently prefer a different source for no principled reason
    // whenever our own (perfectly valid) sum happened to be falsy.
    const dsexClose = liveBreadth?.dsexIndex ?? null;

    // Audit gate before the DSEX/breadth write too.
    const breadthAudit = DataAuditor.auditMarketBreadthSnapshot({
      dsexIndex: dsexClose,
      advancing,
      declining,
      unchanged,
      totalTrades: liveBreadth?.totalTrades ?? null,
      totalVolume: totalVol,
      totalValueMn: totalVal,
    });
    if (!breadthAudit.passed) {
      console.error('[JOB 1] DSEX/breadth write BLOCKED by audit:', breadthAudit.errors);
    } else {
      await saveDSEXDailyClosing({
        dsexIndex: breadthAudit.cleaned.dsexIndex,
        advancing: breadthAudit.cleaned.advancing,
        declining: breadthAudit.cleaned.declining,
        unchanged: breadthAudit.cleaned.unchanged,
        totalTrades: breadthAudit.cleaned.totalTrades,
        totalVolume: totalVol,
        totalValueMn: totalVal,
        source: 'DSE_LIVE_CLOSING'
      }, todayDhakaStr);
    }

    if (savedCount > 0) invalidateStocksCache();
    jobStatusRegistry.job1.lastRun = new Date().toISOString();
    jobStatusRegistry.job1.status = `Completed (${savedCount} scrips & DSEX settlement saved for ${todayDhakaStr})`;
    jobStatusRegistry.job1.recordsIngested = savedCount;

    console.log(`[JOB 1 SUCCESS] Ingested ${savedCount} daily closing records & DSEX settlement into SQLite for ${todayDhakaStr}.`);
    return { success: true, count: savedCount, date: todayDhakaStr };
  } catch (err) {
    jobStatusRegistry.job1.status = `Failed: ${err.message}`;
    console.error('[JOB 1 ERROR]', err);
    return { success: false, error: err.message };
  }
}

// JOB 2: Live Intraday Ticker Sync (Session snapshot, 0 DB writes)
export async function runJob2IntradaySync() {
  if (!isScraperEnabled('server.live_ticker')) {
    jobStatusRegistry.job2.status = 'Disabled (see shared/scraper_registry.js)';
    throw Object.assign(new Error(scraperBlockedMessage('server.live_ticker')), { blocked: true });
  }
  console.log('[JOB 2] Executing Live Intraday Ticker Sync (Session mode, 0 DB writes)...');
  jobStatusRegistry.job2.status = 'Running';

  try {
    const dbStocks = await getAllStocksFromDB();
    const liveRecords = await fetchDSELiveTicker();
    const liveMap = new Map();
    for (const r of liveRecords) liveMap.set(r.symbol, r);

    const enrichedList = dbStocks.map(base => {
      const live = liveMap.get(base.symbol);
      if (!live || !live.ltp || isNaN(live.ltp)) return base;

      const liveLtp = Number(live.ltp);
      let change = live.change !== null && live.change !== undefined && !isNaN(live.change) ? Number(live.change) : null;
      let changePercent = live.changePercent !== null && live.changePercent !== undefined && !isNaN(live.changePercent) ? Number(live.changePercent) : null;
      // `base.ycp || liveLtp` here would default a missing stored ycp to today's
      // own live price -- the same bug as elsewhere in this project (ltp - ltp = 0),
      // just one hop further down the fallback chain. If neither live.ycp nor a
      // derivable change nor a stored base.ycp is available, ycp genuinely isn't
      // known -- stays null, and change/changePercent are left null below rather
      // than computed against a fabricated baseline.
      const hasBaseYcp = base.ycp !== null && base.ycp !== undefined;
      let ycp = live.ycp !== null && live.ycp !== undefined && !isNaN(live.ycp)
        ? Number(live.ycp)
        : (change !== null ? Number((liveLtp - change).toFixed(2)) : (hasBaseYcp ? Number(base.ycp) : null));

      if ((change === null || isNaN(change)) && ycp !== null) {
        change = Number((liveLtp - ycp).toFixed(2));
        changePercent = ycp > 0 ? Number(((change / ycp) * 100).toFixed(2)) : null;
      }

      // Circuit-breaker sanity check: DSE daily price band limit is +-10%
      if (changePercent !== null && Math.abs(changePercent) > 25) {
        // `isNaN(null)` is false in JS (null coerces to 0), so the old
        // `!== undefined && !isNaN(...)` check let a null live.change through to
        // Number(null) -> 0, same bug class as everywhere else in this file.
        if (live.change !== undefined && live.change !== null && !isNaN(live.change)) {
          change = Number(live.change);
          changePercent = Number(live.changePercent);
          ycp = Number((liveLtp - change).toFixed(2));
        } else {
          // Anomalous reading with no real corroborating value to correct it against
          // -- leave unknown rather than guessing "no change" (ycp = liveLtp was the
          // same fabrication bug a third time).
          ycp = null;
          change = null;
          changePercent = null;
        }
      }
      
      const eps = base.eps !== null && base.eps > 0 ? Number(base.eps) : null;
      const dailyPe = eps ? Number((liveLtp / eps).toFixed(2)) : base.dailyPe;

      return {
        ...base,
        ltp: liveLtp,
        ycp,
        change,
        changePercent,
        momentum: changePercent,
        pe: dailyPe,
        dailyPe,
        isLiveSession: true
      };
    });

    jobStatusRegistry.job2.lastRun = new Date().toISOString();
    jobStatusRegistry.job2.status = `Completed (${enrichedList.length} scrips in session)`;

    return {
      fetchedAt: new Date().toISOString(),
      count: enrichedList.length,
      stocks: enrichedList
    };
  } catch (err) {
    jobStatusRegistry.job2.status = `Failed: ${err.message}`;
    throw err;
  }
}

// JOB 3: Audited Fundamental Disclosures Crawler (Daily Smart Delta Upsert)
export async function runJob3DailyFundamentalsDelta() {
  if (!isScraperEnabled('server.fundamentals_delta')) {
    console.log(scraperBlockedMessage('server.fundamentals_delta'));
    jobStatusRegistry.job3.status = 'Disabled (see shared/scraper_registry.js)';
    return { success: false, blocked: true };
  }
  console.log('[JOB 3] Starting Daily Audited Fundamentals Smart Delta Ingestion...');
  jobStatusRegistry.job3.status = 'Running';

  try {
    const symbols = await loadSymbols();
    if (symbols.length === 0) {
      // Both symbols.json and the DB read came back empty -- fail loud rather
      // than silently scraping a hardcoded 8-symbol placeholder list as if it
      // were the real ~639-symbol universe.
      jobStatusRegistry.job3.status = 'Failed: no symbol source available (symbols.json missing/empty and DB read returned nothing)';
      console.error('[JOB 3 ERROR] loadSymbols() returned empty -- refusing to run against an unknown universe.');
      return { success: false, error: 'No symbol source available' };
    }
    const concurrency = 6;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalBlocked = 0;
    let totalShareholdingSaved = 0;
    const allChangedSymbols = [];

    for (let i = 0; i < symbols.length; i += concurrency) {
      const batch = symbols.slice(i, i + concurrency);
      const scrapedList = [];
      const shareholdingList = [];

      await Promise.all(batch.map(async (sym) => {
        try {
          // scrapeCompanyAuditedFinancials already returns null when epsBasic isn't found,
          // so no separate null-check on data.epsBasic is needed here.
          const data = await scrapeCompanyAuditedFinancials(sym);
          if (!data) {
            totalUnchanged++;
            return;
          }
          // Shareholding is an independent fact from the fundamentals below --
          // audited and collected on its own, same as the weekly scraper.
          if (data.shareholding?.current) {
            const shAudit = DataAuditor.auditShareholdingRecord(sym, data.shareholding.current);
            if (shAudit.passed) {
              shareholdingList.push({ symbol: sym, shareholding: data.shareholding });
            } else {
              console.warn(`[JOB 3] Shareholding BLOCKED ${sym}:`, shAudit.errors);
            }
          }
          // Audit gate: treat this one disclosure as a 1-element statement array
          // (the auditor's per-symbol multi-year shape works fine for 1 element --
          // duplicate-year dedup is just a no-op, the actual sanity checks apply).
          const yearMatch = String(data.auditedPeriod || '').match(/FY(\d{4})/);
          const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
          const audit = DataAuditor.auditFinancialStatements(sym, [{
            year,
            eps: data.epsBasic,
            navps: data.navPerShare,
            dps: null,
            bonus_pct: null,
            pe_ratio: data.peBasic,
            pb_ratio: null,
            dividend_yield: data.dividendYield,
            paid_up_capital_mn: data.paidUpCapitalMn,
            source: 'DSE_OFFICIAL'
          }]);
          if (!audit.passed) {
            console.warn(`[JOB 3] BLOCKED ${sym} by audit:`, audit.errors);
            totalBlocked++;
            return;
          }
          // fiscal_year is fundamentals_history's other PK column (alongside
          // symbol) -- must travel with the record now that Job 3 writes there
          // directly instead of the dropped single-row-per-symbol
          // company_fundamentals table.
          scrapedList.push({ ...data, fiscalYear: year });
        } catch {
          // Keep resilient
        }
      }));

      if (scrapedList.length > 0) {
        const deltaResult = await saveFundamentalsBulkDelta(scrapedList);
        totalUpdated += deltaResult.changedCount;
        totalUnchanged += deltaResult.unchangedCount;
        allChangedSymbols.push(...deltaResult.changedSymbols);
      }

      if (shareholdingList.length > 0) {
        const shResult = await saveShareholdingCurrent(shareholdingList);
        totalShareholdingSaved += shResult.saved;
      }

      await new Promise(r => setTimeout(r, 200)); // Rate-limit safety
    }

    jobStatusRegistry.job3.lastRun = new Date().toISOString();
    jobStatusRegistry.job3.status = `Completed (${totalUpdated} updated, ${totalUnchanged} untouched, ${totalBlocked} blocked by audit, ${totalShareholdingSaved} shareholding snapshots)`;
    jobStatusRegistry.job3.updatedCount = totalUpdated;
    jobStatusRegistry.job3.skippedCount = totalUnchanged;

    console.log(`[JOB 3 SUCCESS] Completed Fundamentals Delta: ${totalUpdated} updated, ${totalUnchanged} skipped (identical), ${totalBlocked} blocked by audit, ${totalShareholdingSaved} shareholding snapshots saved.`);
    return { success: true, updatedCount: totalUpdated, skippedCount: totalUnchanged, changedSymbols: allChangedSymbols, shareholdingSaved: totalShareholdingSaved };
  } catch (err) {
    jobStatusRegistry.job3.status = `Failed: ${err.message}`;
    console.error('[JOB 3 ERROR]', err);
    return { success: false, error: err.message };
  }
}

// Backward-compatibility alias
export const scrapeAll = runJob2IntradaySync;
import { getApiExplorerHtml } from './api_explorer.js';

// -------------------------------------------------------------
// 3. REST API ENDPOINTS
// -------------------------------------------------------------

// Root Interactive API Explorer (Tabular Explorer for Browsers / JSON for API Clients)
app.get('/', (req, res) => {
  const acceptHeader = req.headers['accept'] || '';
  if (req.query.format === 'json' || (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html'))) {
    return res.json({
      status: 'online',
      service: 'DSE Live Scraper & Analytics Engine',
      database: 'SQLite (data/dse.db)',
      timezone: 'Asia/Dhaka (UTC+6)',
      jobs: jobStatusRegistry,
      endpoints: {
        stocks: 'GET /api/stocks (Strict SQLite Master Feed)',
        historyAnalysis: 'GET /api/history-analysis/:symbol (20-Year Institutional Quant Engine)',
        fundamentals: 'GET /api/fundamentals (Audited Company Disclosures)',
        dsexHistory: 'GET /api/dsex-history (20-Year Benchmark History)',
        jobsStatus: 'GET /api/jobs/status (All Job Schedules & Run Logs)',
        fundamentalsHistory: 'GET /api/fundamentals-history/:symbol (20-Year Audited Annual Disclosures)',
        history: 'GET /api/history/:symbol (20-Year Daily Timeline)',
        testSeed: 'GET /api/test-seed (SQLite Health Diagnostics)'
      }
    });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getApiExplorerHtml());
});

// Health check endpoint for cloud hosting providers (Render, Railway, Fly.io)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Dhaka'
  });
});

// Public pricing -- the frontend fetches this rather than hardcoding a
// second copy of PLANS, so a price change only ever needs to happen in one
// place (shared/plans.js). No auth needed, this is public pricing info.
app.get('/api/plans', (req, res) => {
  res.json({ plans: PLANS, freeWindowDays: FREE_WINDOW_DAYS });
});

// Public, no auth -- the runtime-tunable settings the frontend itself needs
// (freeCompareLimit, the site announcement banner). See shared/app_settings.js;
// deliberately excludes anything from shared/plans.js, which is a separate,
// code-reviewed config file by design.
app.get('/api/app-config', (req, res) => {
  res.json(getAllSettings());
});

// Branded share-preview image for a Deep Dive link (see server/og_image.js).
// Public, no auth -- this is exactly what's meant to be shown when someone
// who doesn't have an account shares/receives the link. Cached by the CDN/
// browser for 5 minutes (price data, not something that needs to be
// millisecond-fresh in a link preview).
app.get('/api/og-image/:symbol', async (req, res) => {
  try {
    const png = await generateDeepDiveOgImage(req.params.symbol);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(png);
  } catch (err) {
    console.error('[OG IMAGE ERROR]', err.message);
    res.status(500).send('Failed to generate image');
  }
});

// -------------------------------------------------------------
// USER AUTH (Google Sign-In only -- see the approved premium-tier plan)
// -------------------------------------------------------------

// Frontend posts the Google Identity Services ID token here after sign-in.
// The token is verified server-side (never trust a client-asserted email) --
// see verifyGoogleIdToken in server/auth.js.
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'idToken is required' });
  }
  try {
    const verified = await verifyGoogleIdToken(idToken);
    if (!verified) {
      return res.status(401).json({ error: 'Invalid Google ID token' });
    }
    const user = await upsertUserFromGoogle(verified);
    const { token, expiresAt } = await createSession(user.id);
    res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.json({
      status: 'success',
      user: { id: user.id, email: user.email, name: user.name },
      expiresAt
    });
  } catch (err) {
    console.error('[AUTH GOOGLE ERROR]', err.message);
    res.status(500).json({ error: 'Sign-in failed' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  await destroySession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ status: 'success' });
});

// Current session's identity + entitlement status -- the frontend calls
// this on load to know whether to show signed-in state, and polls it after
// a payment redirect to detect when the entitlement lands (see Phase 4).
app.get('/api/auth/me', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    return res.json({ signedIn: false, user: null, isEntitled: false });
  }
  try {
    const user = await getSessionUser(token);
    if (!user) {
      return res.json({ signedIn: false, user: null, isEntitled: false });
    }
    const entitled = await isEntitled(user.id);
    res.json({
      signedIn: true,
      user: { id: user.id, email: user.email, name: user.name },
      isEntitled: entitled,
      isAdmin: isAdminEmail(user.email)
    });
  } catch (err) {
    console.error('[AUTH ME ERROR]', err.message);
    res.status(500).json({ error: 'Failed to resolve session' });
  }
});

// Promo code redemption -- requires a signed-in session; the actual
// "already redeemed" / "invalid code" logic lives in redeemPromoCode
// (server/entitlements.js), this route is just the HTTP wrapper.
app.post('/api/promo/redeem', requireUserAuth, async (req, res) => {
  const { code } = req.body;
  try {
    const result = await redeemPromoCode(req.user.id, code);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    res.json({ status: 'success', premiumUntil: result.premiumUntil, bonusDays: result.bonusDays, bonusHours: result.bonusHours });
  } catch (err) {
    console.error('[PROMO REDEEM ERROR]', err.message);
    res.status(500).json({ error: 'Failed to redeem promo code' });
  }
});

// -------------------------------------------------------------
// WATCHLIST (2026-08-24) -- account-synced, requireUserAuth only (not
// requirePremiumAuth/attachEntitlement -- a personal watchlist is a free-tier
// feature, same as it always was as a localStorage-only list; signing in
// just makes it follow the account across devices instead of staying pinned
// to one browser).
// -------------------------------------------------------------
app.get('/api/watchlist', requireUserAuth, async (req, res) => {
  try {
    const symbols = await getUserWatchlist(req.user.id);
    res.json({ symbols });
  } catch (err) {
    console.error('[WATCHLIST GET ERROR]', err.message);
    res.status(500).json({ error: 'Failed to load watchlist' });
  }
});

// One-time merge on first sign-in -- see mergeUserWatchlist's own docstring.
// Idempotent, safe to call every sign-in (already-present symbols are a
// no-op). MUST be registered before POST /api/watchlist/:symbol below --
// Express matches routes in registration order, and :symbol is a wildcard
// that would otherwise swallow this literal path first, treating every
// merge call as "add a stock literally named MERGE" (found live 2026-08-24:
// exactly that happened on the first real test, a fake "MERGE" symbol
// landed in the test account's watchlist).
app.post('/api/watchlist/merge', requireUserAuth, async (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols)) {
    return res.status(400).json({ error: 'symbols array required' });
  }
  try {
    const merged = await mergeUserWatchlist(req.user.id, symbols);
    res.json({ status: 'success', symbols: merged });
  } catch (err) {
    console.error('[WATCHLIST MERGE ERROR]', err.message);
    res.status(500).json({ error: 'Failed to merge watchlist' });
  }
});

app.post('/api/watchlist/:symbol', requireUserAuth, async (req, res) => {
  try {
    const result = await addToUserWatchlist(req.user.id, req.params.symbol);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[WATCHLIST ADD ERROR]', err.message);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

app.delete('/api/watchlist/:symbol', requireUserAuth, async (req, res) => {
  try {
    const result = await removeFromUserWatchlist(req.user.id, req.params.symbol);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[WATCHLIST REMOVE ERROR]', err.message);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// -------------------------------------------------------------
// PAYMENTS (SSLCommerz -- see server/payments.js for the full design/
// verification rules)
// -------------------------------------------------------------

app.post('/api/payments/initiate', requireUserAuth, async (req, res) => {
  const { plan } = req.body;
  try {
    const result = await initiatePayment(req.user, plan);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    res.json({ status: 'success', redirectUrl: result.redirectUrl });
  } catch (err) {
    console.error('[PAYMENTS INITIATE ERROR]', err.message);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

// SSLCommerz's success/fail/cancel/ipn all land here (?status= distinguishes
// them) -- entitlement is only ever granted via verifyAndGrant's independent
// re-check, never trusted from this payload directly (see payments.js).
// success/fail/cancel are browser redirects (SSLCommerz POSTs the user's
// browser here), so this responds by redirecting to the frontend result
// page; ipn is a server-to-server call SSLCommerz doesn't expect a redirect
// from, so that branch just acknowledges with 200.
app.post('/api/payments/callback', async (req, res) => {
  const status = req.query.status;
  const tranId = req.body.tran_id;
  const valId = req.body.val_id;

  let result = { ok: false, reason: 'Payment not completed' };
  if (status === 'success' || status === 'ipn') {
    try {
      result = await verifyAndGrant(tranId, valId);
    } catch (err) {
      console.error('[PAYMENTS CALLBACK ERROR]', err.message);
      result = { ok: false, reason: 'Verification failed' };
    }
  }

  if (status === 'ipn') {
    return res.status(200).json({ received: true, verified: result.ok });
  }

  const outcome = result.ok ? 'success' : (status === 'cancel' ? 'cancelled' : 'failed');
  res.redirect(302, `${FRONTEND_RESULT_URL}?outcome=${outcome}`);
});

app.get('/api/payments/history', requireUserAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, gateway, amount_bdt, status, plan, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ payments: rows });
  } catch (err) {
    console.error('[PAYMENTS HISTORY ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// Stocks API: Strictly pull from SQLite Database only (with 15s in-memory cache)
app.get('/api/stocks', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedStocks && (now - lastStocksFetchTime < STOCKS_CACHE_TTL)) {
      res.setHeader('Cache-Control', 'public, max-age=15');
      return res.json(cachedStocks);
    }

    const stocks = await getAllStocksFromDB();
    if (stocks && stocks.length > 0) {
      cachedStocks = stocks;
      lastStocksFetchTime = now;
      res.setHeader('Cache-Control', 'public, max-age=15');
      return res.json(stocks);
    }

    return res.json([]);
  } catch (err) {
    console.error('Error in /api/stocks:', err.message);
    res.status(500).json({ error: 'Failed to fetch stocks from SQLite database' });
  }
});

// Screener flags (Dividend Aristocrats / Turnaround Candidates) -- see
// getScreenerFlags's own docstring for why this is separate from /api/stocks.
// Always free, same as the main screener's other quick-filter chips.
app.get('/api/screener-flags', async (req, res) => {
  try {
    const flags = await getScreenerFlags();
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(flags);
  } catch (err) {
    console.error('Error in /api/screener-flags:', err.message);
    res.status(500).json({ error: 'Failed to compute screener flags' });
  }
});

// Sector Performance -- pairs with Sector Standing on the Deep Dive page,
// same "detailed fundamental analysis" gate. `days` query param: a number,
// or 'all' for the full archive. Locked shape mirrors applyDeepDiveGate's
// convention (real: null, locked: true) rather than a different shape per
// endpoint.
app.get('/api/sector-performance/:symbol', attachEntitlement, async (req, res) => {
  try {
    if (!req.isEntitled) {
      return res.json({ symbol: req.params.symbol.toUpperCase(), sector: null, stockReturn: null, sectorAvgReturn: null, peerCount: null, locked: true });
    }
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Number(daysParam) || 365;
    const perf = await getSectorPerformance(req.params.symbol, days);
    if (!perf) {
      return res.status(404).json({ error: `Sector performance not found for ${req.params.symbol}` });
    }
    // Same fix as /api/history-analysis: `public` here let a browser's HTTP
    // cache serve this entitled response back out to a later request on the
    // same URL that should have hit the locked branch above instead.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(perf);
  } catch (err) {
    console.error('Error in /api/sector-performance:', err.message);
    res.status(500).json({ error: 'Failed to compute sector performance' });
  }
});


app.post('/api/scrape', async (req, res) => {
  try {
    const result = await runJob2IntradaySync();
    res.json({ status: 'ok', result, stocks: result.stocks });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});
app.post('/api/jobs/intraday', async (req, res) => {
  try {
    const result = await runJob2IntradaySync();
    res.json({ status: 'ok', result, stocks: result.stocks });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Job 1: Trigger Daily Closing Settlement Ingestion
// Admin-gated (2026-08-23): unlike Job 2 above (the "Sync Live" button every
// visitor already uses -- 0 DB writes, cheap), Job 1/Job 3 are expensive
// full-market scrapes/writes that were never meant for public on-demand
// triggering -- they're normally cron-driven. requireAdminAuth here, not on
// /api/scrape /api/jobs/intraday, which stay exactly as they were.
app.post('/api/jobs/closing', requireAdminAuth, async (req, res) => {
  try {
    const result = await runJob1ClosingPrices();
    res.json({ status: 'ok', result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Job 3: Trigger Audited Fundamentals Delta Crawler
app.post('/api/jobs/fundamentals', requireAdminAuth, async (req, res) => {
  try {
    runJob3DailyFundamentalsDelta().catch(e => console.error('Job 3 error:', e.message));
    res.json({ status: 'ok', message: 'Daily Fundamentals Delta Crawl initiated in background' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Fetch 20-Year Daily Closing DSEX Benchmark Historical Timeline
app.get('/api/dsex-history', async (req, res) => {
  const limit = parseInt(req.query.limit || '7500', 10);
  try {
    const timeline = await getDSEXHistoricalTimeline(limit);
    // source/tier are internal provenance tracking (see ARCHITECTURE.md),
    // not something the public API should expose -- stripped here, at the
    // response boundary, rather than never fetching them (db_auditor.js and
    // other internal callers of getDSEXHistoricalTimeline still need them).
    res.json({ count: timeline.length, timeline: stripInternalFields(timeline) });
  } catch (err) {
    console.error('Error fetching DSEX history:', err.message);
    res.status(500).json({ error: 'Failed to fetch DSEX history' });
  }
});

// Fetch Cached Fundamentals Strictly from SQLite
app.get('/api/fundamentals', async (req, res) => {
  try {
    const data = await getAllFundamentalsMap();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fundamentals' });
  }
});

// Job Status Registry: Returns schedule & last run info for all 4 jobs
app.get('/api/jobs/status', (req, res) => {
  // cronAvailable=false means node-cron failed to import at boot -- zero jobs
  // are scheduled, and previously the only sign was a buried console.warn.
  // Surfaced here so a caller (or a health check) can actually detect it.
  // Kept flat (not nested under a `jobs` key) -- the dashboard reads
  // jobStatus.job1.lastRun etc. directly off the top-level response.
  res.json({ ...jobStatusRegistry, cronAvailable: !!cron });
});

// Fetch Historical Timeline Strictly from SQLite
app.get('/api/history/:symbol', attachEntitlement, async (req, res) => {
  const sym = req.params.symbol;
  const limit = parseInt(req.query.limit || '7500', 10);
  try {
    const rows = await getHistoricalTimeline(sym, limit);
    // Free users get the last ~6 months (rolling); the full 13-year archive
    // requires an active entitlement -- see shared/gating_logic.js.
    const gated = filterRowsByDateField(rows, 'fetchedAt', req.freeCutoffDate, req.isEntitled);
    // Same fix as /api/history-analysis and /api/sector-performance: `public`
    // let the browser's HTTP cache hand the full 13-year archive back out on
    // a later, non-entitled request to the same URL -- the single most
    // consequential instance of this bug (longest window, biggest payload).
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      symbol: sym,
      history: gated,
      ...(req.isEntitled ? {} : buildLockedMeta(req.freeCutoffDate))
    });
  } catch (err) {
    // 500, not a silent 200 with history: [] -- getHistoricalTimeline already
    // returns [] honestly for a symbol with genuinely no rows (see db.js); if
    // this catch fires at all, something actually failed (e.g. a real SQL
    // error), and that must not look identical to "this symbol has no history."
    console.error(`Error in /api/history/${sym}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch historical timeline' });
  }
});

// Fetch 20-Year Detailed Historical Analysis & Quantitative Model ("Deep Dive")
app.get('/api/history-analysis/:symbol', attachEntitlement, async (req, res) => {
  const sym = req.params.symbol;
  try {
    const analysis = await getDetailedHistoricalAnalysis(sym);
    if (!analysis) {
      return res.status(404).json({ error: `Historical analysis not found for ${sym}` });
    }
    // db.js computes the full result regardless of entitlement (it has no
    // concept of who's asking) -- gating happens here, at the response
    // boundary, via the same pure function used for its own tests. See
    // shared/gating_logic.js's applyDeepDiveGate docstring for exactly what
    // stays visible (today's price, identity, generic macro content) vs.
    // what gets locked (ATH/ATL/drawdown/valuation/Graham/disclosures --
    // anything that would be silently wrong if recomputed on a truncated window).
    const gated = applyDeepDiveGate(analysis, req.isEntitled, req.freeCutoffDate);
    // `public, max-age=120` (found 2026-08-24 while testing the free-view
    // gate) let the browser's HTTP cache treat this response as shareable
    // across auth states -- entitled-fetch-then-cookie-cleared-fetch on the
    // same URL within 120s served the cached, real (ungated) premium
    // payload to what should have been a locked response. This response
    // varies per-request on req.isEntitled, which the browser cache has no
    // visibility into (no Vary header would make that safe either -- Vary
    // on a cookie is unreliably respected by real browser caches) -- the
    // correct fix is to never let this specific response be cached at all.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(gated);
  } catch (err) {
    console.error(`Error in /api/history-analysis/${sym}:`, err.message);
    res.status(500).json({ error: 'Failed to generate historical analysis' });
  }
});

// Fetch 20-Year Annual Audited Financial Statements Timeline
app.get('/api/fundamentals-history/:symbol', attachEntitlement, async (req, res) => {
  const sym = req.params.symbol;
  try {
    const rows = await getCompanyFundamentalsHistory(sym);
    // Free: latest fiscal year only. Full multi-year archive requires an
    // entitlement -- see limitToLatestFiscalYear's docstring for why this
    // is year-count-based rather than date-cutoff-based like price_history.
    const gated = limitToLatestFiscalYear(rows, req.isEntitled);
    // Explicit for the same reason as the other attachEntitlement routes in
    // this file (found 2026-08-24) -- relying on "no header was ever set"
    // isn't a deliberate safety decision, and this response varies on
    // req.isEntitled exactly like the ones that did have the bug.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      symbol: sym,
      count: gated.length,
      statements: gated,
      ...(req.isEntitled ? {} : buildLockedMeta(req.freeCutoffDate))
    });
  } catch (err) {
    // 500, not a silent 200 with statements: [] -- same fix as /api/history/:symbol
    // above. getCompanyFundamentalsHistory no longer swallows its own errors
    // (db.js), so a real failure now actually reaches here instead of always
    // looking identical to "this symbol has no audited statements on file."
    console.error(`Error in /api/fundamentals-history/${sym}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch fundamentals history' });
  }
});

// Download Job 1 Price History (20 Years) CSV
app.get('/api/download/job1-price-history', requirePremiumAuth, (req, res) => {
  const file = path.join(DATA_DIR, 'job1_price_history_20y.csv');
  if (fs.existsSync(file)) {
    res.download(file, 'job1_price_history_20y.csv');
  } else {
    res.status(404).send('Job 1 price history CSV file not found.');
  }
});

// Download Job 1 DSEX Market History (20 Years) CSV
// Not gated: dsex_market_history is always free (see the locked decisions
// in the approved plan -- only price_history/fundamentals_history/deep-dive
// require an entitlement, the index benchmark and company roster don't).
app.get('/api/download/job1-dsex-history', (req, res) => {
  const file = path.join(DATA_DIR, 'job1_dsex_market_history_20y.csv');
  if (fs.existsSync(file)) {
    res.download(file, 'job1_dsex_market_history_20y.csv');
  } else {
    res.status(404).send('Job 1 DSEX market history CSV file not found.');
  }
});

// Download Job 3 Fundamentals History (20 Years) CSV
app.get('/api/download/job3-fundamentals-history', requirePremiumAuth, (req, res) => {
  const file = path.join(DATA_DIR, 'job3_fundamentals_history_20y.csv');
  if (fs.existsSync(file)) {
    res.download(file, 'job3_fundamentals_history_20y.csv');
  } else {
    res.status(404).send('Job 3 fundamentals history CSV file not found.');
  }
});

// Download Job 3 Company Fundamentals Master Snapshot CSV
// Not gated: this is the CURRENT/latest-fiscal-year snapshot per company
// (same "latest year is free" boundary as GET /api/fundamentals-history/:symbol
// -- see limitToLatestFiscalYear), not the multi-year archive. Only
// job1-price-history and job3-fundamentals-history above are the actual
// historical-archive exports that require an entitlement.
app.get('/api/download/job3-company-fundamentals', (req, res) => {
  const file = path.join(DATA_DIR, 'job3_company_fundamentals_master.csv');
  if (fs.existsSync(file)) {
    res.download(file, 'job3_company_fundamentals_master.csv');
  } else {
    res.status(404).send('Job 3 company fundamentals master CSV file not found.');
  }
});

// -------------------------------------------------------------
// SECURE DATA INGESTION API (FOR DSEPULSE-PIPELINE ENGINE)
// -------------------------------------------------------------
// No fallback: a hardcoded default here would mean any deployment that forgets
// to set INGEST_API_KEY silently runs with a key visible in this source file
// (and formerly in .env.example too), leaving the ingest endpoints open to
// anyone who reads the repo. Crash at boot instead -- missing config should be
// loud, not a silently-guessable default.
if (!process.env.INGEST_API_KEY) {
  console.error('[FATAL] INGEST_API_KEY is not set. Refusing to start with a default/guessable ingest key.');
  process.exit(1);
}
const INGEST_API_KEY = process.env.INGEST_API_KEY;

function requireIngestAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: Ingestion API key required' });
  }
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (token !== INGEST_API_KEY) {
    return res.status(403).json({ error: 'Forbidden: Invalid Ingestion API key' });
  }
  next();
}

// Ingest Live Market Snapshot & Closing Prices from Pipeline
app.post('/api/ingest/live', requireIngestAuth, async (req, res) => {
  const { stocks, marketBreadth, date } = req.body;
  if (!stocks || !Array.isArray(stocks)) {
    return res.status(400).json({ error: 'Payload must contain stocks array' });
  }
  try {
    const tradeDate = date || new Date().toISOString().slice(0, 10);
    // saveDailyClosingToDB(records, dateStr) takes an ARRAY of records for one
    // shared date, not (symbol, record) -- the previous per-stock loop called it as
    // saveDailyClosingToDB(stock.symbol, {...}), a string where an array was
    // required. Array.isArray(stock.symbol) is false, so the function's own guard
    // returned 0 and wrote nothing, silently, on every single call -- this endpoint
    // has never actually saved a closing price. Building one array and calling it
    // once (its real designed use: many symbols, one date) both fixes that and
    // avoids one transaction per stock, the same fix applied to /api/ingest/history
    // earlier.
    // Tier 1 -- a live scrape of DSE's own live-ticker page.
    const closingRecords = stocks
      .filter(s => s.symbol && s.ltp !== null && s.ltp !== undefined)
      .map(s => ({
        symbol: s.symbol,
        close: Number(s.ltp),
        // No 0 fallbacks: preserve null for anything the snapshot didn't actually
        // have rather than asserting a fabricated "no change"/"zero volume".
        ycp: numOrNull(s.ycp),
        change: numOrNull(s.change),
        changePercent: numOrNull(s.changePercent),
        volume: numOrNull(s.volume),
        pe: numOrNull(s.pe),
        source: 'DSE_LIVE_TICKER'
      }));
    const closingIngested = await saveDailyClosingToDB(closingRecords, tradeDate);

    if (marketBreadth) {
      // intraday_breadth_snapshot was dropped 2026-08-23 along with Job 4 (see
      // ARCHITECTURE.md) -- this endpoint's dsex_market_history write below is
      // unaffected and still real/wanted, only the breadth-snapshot save itself
      // is gone.
      const dsexIndex = numOrNull(marketBreadth.dsexIndex);
      if (dsexIndex !== null) {
        // Field names must match what saveDSEXDailyClosing actually reads
        // (totalTrades/totalVolume/totalValueMn) -- turnoverMn/volume (the names
        // this call used before) aren't read at all and were silently dropped,
        // the same bug already found and fixed at /api/ingest/dsex but missed
        // here since it's a separate call site.
        await saveDSEXDailyClosing({
          dsexIndex,
          advancing: numOrNull(marketBreadth.advancing),
          declining: numOrNull(marketBreadth.declining),
          unchanged: numOrNull(marketBreadth.unchanged),
          totalTrades: numOrNull(marketBreadth.totalTrades),
          totalVolume: numOrNull(marketBreadth.totalVolume),
          totalValueMn: numOrNull(marketBreadth.turnoverMn ?? marketBreadth.totalValueMn),
          source: 'DSE_LIVE_TICKER'
        }, tradeDate);
      }
    }

    // Update latest.json disk cache
    const snapshot = {
      timestamp: new Date().toISOString(),
      date: tradeDate,
      totalStocks: stocks.length,
      marketBreadth: marketBreadth || null,
      stocks: stocks
    };
    await fs.writeJson(LATEST_FILE, snapshot, { spaces: 2 });
    invalidateStocksCache();

    res.json({
      status: 'success',
      message: `Ingested ${stocks.length} live stocks & ${closingIngested} closing records`,
      date: tradeDate
    });
  } catch (err) {
    console.error('[INGEST LIVE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ingest Company Fundamentals & 20-Year Statements from Pipeline
app.post('/api/ingest/fundamentals', requireIngestAuth, async (req, res) => {
  const { symbol, statements } = req.body;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    const cleanSym = symbol.toUpperCase().trim();
    // The `fundamentals` singular field (a separate "current snapshot" write)
    // is no longer handled here -- company_fundamentals was dropped
    // 2026-08-23 (see ARCHITECTURE.md); "current" is now derived by querying
    // fundamentals_history for each symbol's latest fiscal_year row, so there's
    // nothing left to save it into. Callers may still send it harmlessly; it's
    // simply ignored.
    if (statements && Array.isArray(statements) && statements.length > 0) {
      // fundamentals_history is the audited historical record, one row per
      // (symbol, fiscal_year). Per policy: a year already promoted as 'Audited'
      // is never overwritten by anything, including a later promotion run.
      // But DO NOTHING would also permanently block a real audited disclosure
      // from ever landing if Job 3's own 'Provisional' tracking got to that
      // (symbol, fiscal_year) first -- so this upgrades Provisional -> Audited
      // when the row already exists, and only refuses when it's already Audited.
      //
      // Wrapped in one transaction (2026-08-23 fix) -- this used to be one
      // un-batched await per statement, same anti-pattern saveSymbolHistoryBulk's
      // own docstring calls out (one commit/fsync per row instead of one per
      // request), and with no rollback: a mid-loop failure left a partially
      // promoted symbol with no way to know which years actually landed.
      await dbRun('BEGIN TRANSACTION');
      try {
        for (const s of statements) {
          await dbRun(`
            INSERT INTO fundamentals_history (
              symbol, fiscal_year, period, eps_basic, nav_per_share, roe,
              dividend_yield, dps, pe_ratio, debt_to_equity, current_ratio,
              paid_up_capital_mn, audit_status, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
              period = excluded.period,
              eps_basic = excluded.eps_basic,
              nav_per_share = excluded.nav_per_share,
              roe = excluded.roe,
              dividend_yield = excluded.dividend_yield,
              dps = excluded.dps,
              pe_ratio = excluded.pe_ratio,
              debt_to_equity = excluded.debt_to_equity,
              current_ratio = excluded.current_ratio,
              paid_up_capital_mn = excluded.paid_up_capital_mn,
              audit_status = excluded.audit_status,
              source = excluded.source
            WHERE fundamentals_history.audit_status IS NOT 'Audited'
          `, [
            cleanSym,
            Number(s.year || s.fiscal_year),
            s.period || 'Annual',
            // numOrNull, not a hand-rolled `!== undefined` check: that alone is
            // NOT a null check (Number(null) is 0), so a genuinely null field
            // (undisclosed) was silently written as a fabricated "confirmed
            // zero" P/E, paid-up capital, ROE, etc. for every one of these 8
            // fields -- the exact fundamentals_history incident (ARCHITECTURE.md).
            numOrNull(s.eps),
            numOrNull(s.navps),
            numOrNull(s.roe),
            numOrNull(s.dividendYield),
            numOrNull(s.dps),
            numOrNull(s.pe),
            numOrNull(s.debtToEquity),
            numOrNull(s.currentRatio),
            numOrNull(s.paidUpCapital),
            // Never default an unspecified audit status to 'Audited' -- that's a
            // verification claim, not a structural label, and asserting it by
            // default would falsely certify data whose provenance wasn't stated.
            s.auditStatus || null,
            // Every promoted row is STAGING_DB now (staging = Tier 1 for main
            // DB's purposes) -- see shared/source_tiers.js.
            'STAGING_DB'
          ]);
        }
        await dbRun('COMMIT');
      } catch (err) {
        await dbRun('ROLLBACK');
        throw err;
      }
    }
    invalidateStocksCache();
    res.json({
      status: 'success',
      symbol: cleanSym,
      statementsCount: statements?.length || 0
    });
  } catch (err) {
    console.error('[INGEST FUNDAMENTALS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ingest Price History Batch from Pipeline
app.post('/api/ingest/history', requireIngestAuth, async (req, res) => {
  const { symbol, history } = req.body;
  if (!symbol || !Array.isArray(history)) {
    return res.status(400).json({ error: 'symbol and history array required' });
  }
  try {
    const cleanSym = symbol.toUpperCase().trim();
    // saveSymbolHistoryBulk writes this symbol's whole history in ONE transaction.
    // The previous version called saveDailyClosingToDB (its own BEGIN/COMMIT per
    // call) once per row -- fine for Job 1's "one date, many symbols" case, but for
    // "one symbol, thousands of dates" it meant thousands of separate commits per
    // request, slow enough to time out the pipeline promoter mid-symbol.
    const count = await saveSymbolHistoryBulk(cleanSym, history);
    // history is always this symbol's COMPLETE current staging record set (the
    // promoter sends the whole per-symbol history in one call, never a partial
    // update) -- safe to treat any date missing from it as no longer valid and
    // prune, scoped to DSE_SCRAPE/LANKABD only so Job 1's own DSE_LIVE_CLOSING
    // writes are never touched. See pruneOrphanedPriceHistoryRows in db.js.
    const pruned = await pruneOrphanedPriceHistoryRows(cleanSym, history.map(h => h.date).filter(Boolean));
    invalidateStocksCache();
    res.json({ status: 'success', symbol: cleanSym, insertedCount: count, prunedCount: pruned });
  } catch (err) {
    console.error('[INGEST HISTORY ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ingest Macro DSEX History Batch from Pipeline
app.post('/api/ingest/dsex', requireIngestAuth, async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'records array required' });
  }
  try {
    let count = 0;
    // saveDSEXDailyClosing(data, dateStr) takes the date as a SEPARATE second argument,
    // not as a property of `data` -- passing it inside the object (as this used to) left
    // dateStr undefined, so every call fell back to today's date and repeatedly
    // overwrote a single row instead of writing each historical date. Field names must
    // also match what the function reads (totalTrades/totalVolume/totalValueMn), not
    // turnoverMn/volume, which it silently ignores.
    // Preserve null for anything the source record didn't actually have (e.g. the
    // Kaggle-sourced index history has a real dsexIndex but no breadth figures at
    // all) -- coercing a missing field to 0 before it reaches saveDSEXDailyClosing
    // would defeat that function's own null-handling and write a fabricated
    // "confirmed zero" into permanent history for a field that was never scraped.
    for (const r of records) {
      const dsexIndex = numOrNull(r.dsexIndex ?? r.dsex_index);
      if (r.date && dsexIndex !== null) {
        await saveDSEXDailyClosing({
          dsexIndex,
          advancing: numOrNull(r.advancing),
          declining: numOrNull(r.declining),
          unchanged: numOrNull(r.unchanged),
          totalTrades: numOrNull(r.totalTrades ?? r.total_trades),
          totalVolume: numOrNull(r.volume ?? r.total_volume),
          totalValueMn: numOrNull(r.turnoverMn ?? r.total_value_mn),
          source: r.source || null
        }, r.date);
        count++;
      }
    }
    // records is always the COMPLETE current stg_index_history table (the
    // promoter sends the whole table in one call, never a partial update) --
    // safe to treat any date missing from it as no longer valid and prune,
    // scoped to staging-owned sources only so Job 1/Job 2's own
    // DSE_LIVE_CLOSING/DSE_LIVE_TICKER writes are never touched. Built from
    // every r.date present (not just ones with a parseable dsexIndex) so a
    // record that failed the null-check above still protects its date from
    // being pruned -- "staging still has a row here" and "that row's index
    // value happened to fail validation" are different facts. See
    // pruneOrphanedDSEXRows in db.js.
    const pruned = await pruneOrphanedDSEXRows(records.map(r => r.date).filter(Boolean));
    invalidateStocksCache();
    res.json({ status: 'success', insertedCount: count, prunedCount: pruned });
  } catch (err) {
    console.error('[INGEST DSEX ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ingest full company/instrument roster from Pipeline (added 2026-08-23,
// mirrors stg_company_list). records is always the complete current staging
// table -- saveCompanyList upserts everything present and prunes anything no
// longer there (this table has no live writer of its own, so a full sync
// needs no source-based scoping like the price/dsex prune functions do).
app.post('/api/ingest/companylist', requireIngestAuth, async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'records array required' });
  }
  try {
    const result = await saveCompanyList(records);
    invalidateStocksCache();
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[INGEST COMPANYLIST ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Promoted from pipeline/'s stg_shareholding_current (see manual_promoter.js)
// -- same saveShareholdingCurrent used by server/'s own live scraper path
// (server/scrapers/audited_eps_scraper.js), so both routes to this table go
// through one write path. Each record: { symbol, shareholding: { current, previous } }.
app.post('/api/ingest/shareholding', requireIngestAuth, async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'records array required' });
  }
  try {
    const result = await saveShareholdingCurrent(records);
    invalidateAnalysisCache();
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[INGEST SHAREHOLDING ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN PANEL (all routes require requireAdminAuth -- see server/admin_routes.js)
// -------------------------------------------------------------
app.use('/api/admin', createAdminRouter({
  jobStatusRegistry,
  jobTriggers: {
    closing: runJob1ClosingPrices,
    fundamentals: runJob3DailyFundamentalsDelta,
    intraday: runJob2IntradaySync,
  },
}));

// -------------------------------------------------------------
// 4. CRON AUTOMATION SCHEDULER (DHAKA TIMEZONE: Asia/Dhaka)
// -------------------------------------------------------------
if (cron) {
  // Job 1: Daily Closing Prices Scraper (Sun-Thu @ 15:30 BST)
  cron.schedule('30 15 * * 0-4', () => {
    console.log('[CRON TRIGGER] Executing Job 1: Official Daily Closing Prices Scraper...');
    runJob1ClosingPrices();
  }, { timezone: 'Asia/Dhaka' });

  // Job 3: Daily Audited Fundamentals Delta Crawler (Sun-Thu @ 16:00 BST)
  cron.schedule('0 16 * * 0-4', () => {
    console.log('[CRON TRIGGER] Executing Job 3: Daily Audited Fundamentals Delta Crawler...');
    runJob3DailyFundamentalsDelta();
  }, { timezone: 'Asia/Dhaka' });

  // The weekly full-universe audited EPS cron was removed 2026-08-22: confirmed
  // via direct comparison that it ran the identical scrapeCompanyAuditedFinancials
  // -> audit -> saveFundamentalsBulkDelta pipeline as Job 3 above, just less often
  // and against a narrower symbol set (existing company_fundamentals rows only,
  // vs Job 3's broader loadSymbols()) -- pure redundancy, not a distinct check.
  // runAuditedEPSWeeklyScraper() itself is kept for its one real remaining use:
  // scripts/scrape_audited_eps.js, a manual on-demand full-universe re-scrape.

  console.log('[CRON] Automated scheduler active for Job 1 (15:30 BST) and Job 3 (16:00 BST).');
} else {
  console.warn('[CRON] node-cron not initialized.');
}

const DIST_DIR = path.join(__dirname, '..', 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: serve index.html for any non-API route (compatible with Express 4 & 5)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Auto-boot SQLite DB Initialization on Start
// No auto-seeding here on purpose -- every row in this DB must come from a real
// DSE/LankaBangla scrape via the pipeline's audited promotion process, never from
// a bundled fallback dataset. If the DB is empty, the API honestly returns empty,
// which the frontend already handles (loading/empty states, no fake data).
async function startServer() {
  await initDB();

  // Load any admin-panel scraper overrides recorded in the DB (survives a
  // restart) into the in-memory runtime-override map (shared/scraper_registry.js)
  // -- otherwise a toggle an admin made before the last restart would
  // silently revert to the registry file's default the moment the process
  // restarted, even though the DB still remembers the admin's real choice.
  try {
    const overrides = await dbAll(`SELECT scraper_key, enabled FROM scraper_settings`);
    for (const row of overrides) setRuntimeOverride(row.scraper_key, row.enabled === 1);
    if (overrides.length > 0) {
      console.log(`[ADMIN] Loaded ${overrides.length} scraper override(s) from scraper_settings.`);
    }
    // Re-validate the mutual-exclusion invariant now that overrides are
    // loaded -- a DB state saved before this check existed (or edited
    // directly) must not silently boot into a conflicting state.
    assertNoConflictingScrapers();
  } catch (err) {
    console.error('[FATAL] Refusing to start:', err.message);
    process.exit(1);
  }

  // Same boot-load as scraper_settings above, for shared/app_settings.js's
  // admin-tunable config (freeCompareLimit, the announcement banner).
  try {
    const settingRows = await dbAll(`SELECT setting_key, value_json FROM app_settings`);
    for (const row of settingRows) setSettingOverride(row.setting_key, JSON.parse(row.value_json));
    if (settingRows.length > 0) {
      console.log(`[ADMIN] Loaded ${settingRows.length} app setting override(s) from app_settings.`);
    }
  } catch (err) {
    console.error('[APP SETTINGS] Failed to load overrides, continuing with defaults:', err.message);
  }

  const PORT = process.env.PORT || 5001;
  app.listen(PORT, () => {
    console.log(`DSE Analytics Server listening on port ${PORT} [DHAKA UTC+6 ENGINE]`);
  });
}

startServer();
