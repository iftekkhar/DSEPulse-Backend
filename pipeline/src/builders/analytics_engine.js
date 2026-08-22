/**
 * analytics_engine.js
 *
 * Technical and performance analytics computed ON DEMAND from staged price history
 * (getSymbolAnalytics), cached in memory for 5 minutes per symbol -- mirroring the
 * same pattern server/db.js already uses successfully in production
 * (getDetailedHistoricalAnalysis + analysisCache). There is no persisted destination
 * for this data in the main DB either (it computes on the fly there too), so
 * pre-computing and storing a full historical table in staging just risked silent
 * staleness (stg_price_history updates were never wired to trigger a recompute) for
 * no benefit -- computing a symbol's indicator series is a single O(n) pass, cheap
 * enough to do per request with a short cache.
 *
 * The one thing still pre-computed and persisted is computeFundamentalDerivedRatios(),
 * which writes into stg_annual_fundamentals -- that table DOES have a promotion
 * destination in the main DB, so it stays a real staged/certifiable table.
 *
 * Indicators computed:
 *   Technical: SMA(20,50,200), EMA(12,26), MACD+Signal, RSI(14),
 *              Bollinger Bands(20,2σ), ATR(14), 52W High/Low
 *   Performance: Returns 1D/1W/1M/3M/6M/1Y/3Y/5Y/10Y/20Y,
 *                CAGR 3Y/5Y/10Y, Sharpe Ratio, Max Drawdown, Ann. Volatility
 */

import { initStagingDB, dbAll, dbRun, dbGet } from '../db/staging_db.js';

const RISK_FREE_RATE = 0.04; // 4% (Bangladesh 10Y T-bill proxy)
const TRADING_DAYS_PER_YEAR = 252;

// ─────────────────────────────────────────────────────────────────────────────
//  MATH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(prices.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    e = prices[i] * k + e * (1 - k);
  }
  return e;
}

function computeAllEMAs(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;

  // Seed with SMA
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = e;

  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    result[i] = e;
  }
  return result;
}

function computeRSI(closes, period = 14) {
  const results = new Array(closes.length).fill(null);
  if (closes.length <= period) return results;

  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  // Initial average
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    results[i + 1] = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  }
  return results;
}

function computeATR(highs, lows, closes, period = 14) {
  const results = new Array(closes.length).fill(null);
  const trs = [];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  if (trs.length < period) return results;

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  results[period] = parseFloat(atr.toFixed(4));
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    results[i + 1] = parseFloat(atr.toFixed(4));
  }
  return results;
}

function rolling52W(closes, dates) {
  // Returns { high, low } for the 52-week window ending at each index
  const result = closes.map(() => ({ high: null, low: null }));
  const WINDOW = 252;
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - WINDOW + 1);
    const slice = closes.slice(start, i + 1);
    result[i] = { high: Math.max(...slice), low: Math.min(...slice) };
  }
  return result;
}

function maxDrawdown(closes) {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (peak - c) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat((-maxDD * 100).toFixed(2));
}

function annualizedVolatility(closes) {
  if (closes.length < 2) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return parseFloat((Math.sqrt(variance * TRADING_DAYS_PER_YEAR) * 100).toFixed(2));
}

function cagr(startPrice, endPrice, years) {
  if (!startPrice || !endPrice || startPrice <= 0 || years <= 0) return null;
  return parseFloat(((Math.pow(endPrice / startPrice, 1 / years) - 1) * 100).toFixed(2));
}

function findClosestPrice(closes, dates, targetDate) {
  // Find the price on or just before the targetDate
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= targetDate) return closes[i];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ON-DEMAND ANALYTICS — computed fresh per symbol, cached in memory
// ─────────────────────────────────────────────────────────────────────────────

const analyticsCache = new Map();
const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, same TTL as server/db.js

/** Call after new price data lands for a symbol so stale cached analytics aren't served. */
export function invalidateSymbolAnalyticsCache(symbol) {
  if (symbol) analyticsCache.delete(String(symbol).toUpperCase().trim());
  else analyticsCache.clear();
}

/**
 * Compute the full technical-indicator series for one symbol from its price
 * history (one row per trading day, same shape stg_computed_analytics used to
 * store). No DB write -- purely in-memory.
 */
function computeTechnicalSeries(rows) {
  if (rows.length < 20) return []; // Need at least 20 rows for SMA20

  const dates  = rows.map(r => r.trade_date);
  const closes = rows.map(r => r.close);
  const highs  = rows.map(r => r.high ?? r.close);
  const lows   = rows.map(r => r.low  ?? r.close);

  const ema12s = computeAllEMAs(closes, 12);
  const ema26s = computeAllEMAs(closes, 26);
  const macds = ema12s.map((e12, i) => (e12 != null && ema26s[i] != null) ? e12 - ema26s[i] : null);
  const macdSignals = computeAllEMAs(macds.filter(v => v != null), 9);
  let macdSignalIdx = 0;
  const macdSignalFull = macds.map(v => (v != null ? (macdSignals[macdSignalIdx++] ?? null) : null));
  const rsi14s = computeRSI(closes, 14);
  const atr14s = computeATR(highs, lows, closes, 14);
  const week52 = rolling52W(closes, dates);

  const prevYearCloses = new Map();
  for (let i = 0; i < dates.length; i++) {
    const prevYear = dates[i].slice(0, 4) - 1;
    if (!prevYearCloses.has(prevYear)) {
      for (let j = i - 1; j >= 0; j--) {
        if (dates[j].startsWith(String(prevYear))) {
          prevYearCloses.set(prevYear, closes[j]);
          break;
        }
      }
    }
  }

  const series = [];
  for (let i = 0; i < dates.length; i++) {
    const slice20  = closes.slice(Math.max(0, i - 19), i + 1);
    const slice50  = closes.slice(Math.max(0, i - 49), i + 1);
    const slice200 = closes.slice(Math.max(0, i - 199), i + 1);

    const sma20 = slice20.length  === 20  ? slice20.reduce((a,b)=>a+b,0)/20  : null;
    const sma50 = slice50.length  === 50  ? slice50.reduce((a,b)=>a+b,0)/50  : null;
    const sma200 = slice200.length === 200 ? slice200.reduce((a,b)=>a+b,0)/200 : null;

    let bollUpper = null, bollLower = null;
    if (sma20 !== null) {
      const std = Math.sqrt(slice20.reduce((a, c) => a + (c - sma20) ** 2, 0) / 20);
      bollUpper = parseFloat((sma20 + 2 * std).toFixed(4));
      bollLower = parseFloat((sma20 - 2 * std).toFixed(4));
    }

    const yearNum = parseInt(dates[i].slice(0, 4));
    const prevClose = prevYearCloses.get(yearNum - 1);
    const annReturn = prevClose ? parseFloat(((closes[i] / prevClose - 1) * 100).toFixed(2)) : null;

    const macd = macds[i];
    const macdSig = macdSignalFull[i];

    series.push({
      trade_date: dates[i],
      sma_20:    sma20   != null ? parseFloat(sma20.toFixed(4))  : null,
      sma_50:    sma50   != null ? parseFloat(sma50.toFixed(4))  : null,
      sma_200:   sma200  != null ? parseFloat(sma200.toFixed(4)) : null,
      ema_12:    ema12s[i] != null ? parseFloat(ema12s[i].toFixed(4)) : null,
      ema_26:    ema26s[i] != null ? parseFloat(ema26s[i].toFixed(4)) : null,
      macd:      macd     != null ? parseFloat(macd.toFixed(4)) : null,
      macd_signal: macdSig != null ? parseFloat(macdSig.toFixed(4)) : null,
      macd_hist: (macd != null && macdSig != null) ? parseFloat((macd - macdSig).toFixed(4)) : null,
      rsi_14:    rsi14s[i],
      boll_upper: bollUpper,
      boll_mid:   sma20 != null ? parseFloat(sma20.toFixed(4)) : null,
      boll_lower: bollLower,
      atr_14:    atr14s[i],
      week52_high: week52[i]?.high ?? null,
      week52_low:  week52[i]?.low  ?? null,
      annual_return_pct: annReturn,
    });
  }
  return series;
}

/**
 * Compute the performance summary for one symbol as of yesterday. No DB write.
 */
function computePerformanceForSymbol(rows, yesterday) {
  if (rows.length < 2) return null;

  const dates  = rows.map(r => r.trade_date);
  const closes = rows.map(r => r.close);
  const lastClose = closes[closes.length - 1];

  const lookbacks = { '1d': 1, '1w': 7, '1m': 30, '3m': 91, '6m': 182, '1y': 365, '3y': 1095, '5y': 1825, '10y': 3650, '20y': 7300 };

  const prices = {};
  const returns = {};
  for (const [key, days] of Object.entries(lookbacks)) {
    const targetDate = new Date(yesterday);
    targetDate.setDate(targetDate.getDate() - days);
    const targetStr = targetDate.toISOString().split('T')[0];
    const price = findClosestPrice(closes, dates, targetStr);
    prices[key] = price;
    returns[key] = price ? parseFloat(((lastClose / price - 1) * 100).toFixed(2)) : null;
  }

  const c3  = prices['3y']  ? cagr(prices['3y'],  lastClose, 3)  : null;
  const c5  = prices['5y']  ? cagr(prices['5y'],  lastClose, 5)  : null;
  const c10 = prices['10y'] ? cagr(prices['10y'], lastClose, 10) : null;

  const vol     = annualizedVolatility(closes);
  const maxDD   = maxDrawdown(closes);
  const annRet  = returns['1y'];
  const sharpe  = (vol && vol > 0 && annRet != null)
    ? parseFloat(((annRet - RISK_FREE_RATE * 100) / vol).toFixed(3))
    : null;

  const start52 = new Date(yesterday);
  start52.setDate(start52.getDate() - 365);
  const start52Str = start52.toISOString().split('T')[0];
  const closes52 = closes.filter((_, i) => dates[i] >= start52Str);
  const w52High = closes52.length ? Math.max(...closes52) : null;
  const w52Low  = closes52.length ? Math.min(...closes52) : null;

  return {
    as_of_date: yesterday, last_close: lastClose,
    price_1d_ago: prices['1d'], price_1w_ago: prices['1w'], price_1m_ago: prices['1m'],
    price_3m_ago: prices['3m'], price_6m_ago: prices['6m'], price_1y_ago: prices['1y'],
    price_3y_ago: prices['3y'], price_5y_ago: prices['5y'], price_10y_ago: prices['10y'], price_20y_ago: prices['20y'],
    return_1d: returns['1d'], return_1w: returns['1w'], return_1m: returns['1m'],
    return_3m: returns['3m'], return_6m: returns['6m'], return_1y: returns['1y'],
    return_3y: returns['3y'], return_5y: returns['5y'], return_10y: returns['10y'], return_20y: returns['20y'],
    cagr_3y: c3, cagr_5y: c5, cagr_10y: c10,
    volatility_ann: vol, max_drawdown: maxDD, sharpe_ratio: sharpe,
    week52_high: w52High, week52_low: w52Low,
  };
}

/**
 * Get one symbol's technical indicator series + performance summary, computed
 * fresh from stg_price_history and cached for 5 minutes. Call
 * invalidateSymbolAnalyticsCache(symbol) after new price data lands for it.
 */
export async function getSymbolAnalytics(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  if (!cleanSym) return null;

  const cached = analyticsCache.get(cleanSym);
  if (cached && (Date.now() - cached.timestamp < ANALYTICS_CACHE_TTL_MS)) {
    return cached.data;
  }

  await initStagingDB();
  const rows = await dbAll(`
    SELECT trade_date, open, high, low, close
    FROM stg_price_history
    WHERE symbol = ? AND close > 0
    ORDER BY trade_date ASC
  `, [cleanSym]);

  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  const data = {
    symbol: cleanSym,
    technical: computeTechnicalSeries(rows),
    performance: computePerformanceForSymbol(rows, yesterday),
  };

  analyticsCache.set(cleanSym, { timestamp: Date.now(), data });
  return data;
}

/**
 * Compute derived fundamental ratios and update stg_annual_fundamentals.
 * PE, PB, ROE, Dividend Yield, Market Cap, CAGR — all derived from
 * official data already in the table.
 */
export async function computeFundamentalDerivedRatios() {
  await initStagingDB();

  const rows = await dbAll(`
    SELECT f.symbol, f.fiscal_year, f.eps, f.navps, f.dps, f.total_shares,
           f.paid_up_capital_mn
    FROM stg_annual_fundamentals f
    WHERE (f.eps IS NOT NULL OR f.navps IS NOT NULL)
    ORDER BY f.symbol, f.fiscal_year
  `);

  console.log(`[Analytics] Computing derived ratios for ${rows.length} fundamental records...`);
  const now = new Date().toISOString();
  let updated = 0;

  for (const row of rows) {
    const { symbol, fiscal_year, eps, navps, dps, total_shares, paid_up_capital_mn } = row;

    // Find fiscal year-end closing price
    const yearEndDate = `${fiscal_year}-06-30`; // Bangladesh fiscal year ends June 30
    const priceRow = await dbGet(`
      SELECT close FROM stg_price_history
      WHERE symbol = ? AND trade_date <= ?
      ORDER BY trade_date DESC LIMIT 1
    `, [symbol, yearEndDate]);

    const year_end_close = priceRow?.close ?? null;

    // Derive total shares from paid-up capital if not available
    let shares = total_shares;
    if (!shares && paid_up_capital_mn && paid_up_capital_mn > 0) {
      // Paid-up capital in mn BDT / face_value (default 10) = shares
      shares = Math.round((paid_up_capital_mn * 1_000_000) / 10);
    }

    const pe_ratio        = (eps && eps > 0 && year_end_close) ? parseFloat((year_end_close / eps).toFixed(2)) : null;
    const pb_ratio        = (navps && navps > 0 && year_end_close) ? parseFloat((year_end_close / navps).toFixed(2)) : null;
    const roe             = (eps && navps && navps > 0) ? parseFloat((eps / navps * 100).toFixed(2)) : null;
    const dividend_yield  = (dps && dps > 0 && year_end_close && year_end_close > 0) ? parseFloat((dps / year_end_close * 100).toFixed(2)) : null;
    const market_cap_mn   = (year_end_close && shares) ? parseFloat((year_end_close * shares / 1_000_000).toFixed(2)) : null;

    // CAGR: find close 3, 5, 10 years before fiscal year end
    const cagr3 = await computePriceCagr(symbol, yearEndDate, 3, year_end_close);
    const cagr5 = await computePriceCagr(symbol, yearEndDate, 5, year_end_close);
    const cagr10 = await computePriceCagr(symbol, yearEndDate, 10, year_end_close);

    await dbRun(`
      UPDATE stg_annual_fundamentals SET
        year_end_close=?, pe_ratio=?, pb_ratio=?, roe=?,
        dividend_yield=?, market_cap_mn=?, total_shares=?, staged_at=?
      WHERE symbol=? AND fiscal_year=?
    `, [year_end_close, pe_ratio, pb_ratio, roe, dividend_yield, market_cap_mn,
        shares, now, symbol, fiscal_year]);

    updated++;
  }

  console.log(`[Analytics] ✅ Fundamental derived ratios updated for ${updated} records.`);
  return updated;
}

async function computePriceCagr(symbol, endDate, years, endClose) {
  if (!endClose || endClose <= 0) return null;
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - years);
  const startDateStr = startDate.toISOString().split('T')[0];

  const row = await dbGet(`
    SELECT close FROM stg_price_history
    WHERE symbol = ? AND trade_date <= ?
    ORDER BY trade_date DESC LIMIT 1
  `, [symbol, startDateStr]);

  return row?.close ? cagr(row.close, endClose, years) : null;
}

/**
 * Run all analytics in sequence.
 */
export async function runFullAnalyticsPipeline() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   DSEPULSE ANALYTICS ENGINE — FUNDAMENTAL RATIOS RUN');
  console.log('   (Technical/performance analytics are computed on demand --');
  console.log('    see getSymbolAnalytics() -- nothing to pre-compute here.)');
  console.log('═══════════════════════════════════════════════════════\n');

  const t3 = await computeFundamentalDerivedRatios();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   ANALYTICS COMPLETE');
  console.log(`   Fundamental rows:   ${t3}`);
  console.log('═══════════════════════════════════════════════════════\n');

  return { fundamental: t3 };
}
