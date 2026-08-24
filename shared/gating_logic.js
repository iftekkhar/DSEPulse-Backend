/**
 * Pure functions deciding what a free (non-entitled) request sees vs. an
 * entitled one. No DB, no HTTP -- these take already-fetched data and an
 * isEntitled boolean and return the gated shape, so they're directly
 * unit-testable (see shared/test_suite.js) without a live server or session.
 *
 * Central rule from the approved plan, enforced here in exactly one place:
 * a locked response NEVER contains a real value past the cutoff, and NEVER
 * contains a synthesized stand-in either -- only `null` and a `locked`
 * marker. The frontend is responsible for turning `locked` into a blurred
 * placeholder; this layer's only job is to make sure nothing real leaks
 * past it.
 */

/** { locked: true, unlockUrl, freeFrom } -- the standard "this is gated" marker. */
export function buildLockedMeta(cutoffDate) {
  return { locked: true, unlockUrl: '/plans', freeFrom: cutoffDate };
}

/**
 * Filters an array of date-keyed rows (price_history/dsex_market_history-shaped)
 * to dateField >= cutoffDate. Used for /api/history and similar raw-row
 * endpoints. When isEntitled, returns everything unchanged.
 */
export function filterRowsByDateField(rows, dateField, cutoffDate, isEntitled) {
  if (isEntitled) return rows;
  if (!Array.isArray(rows)) return rows;
  return rows.filter(r => typeof r?.[dateField] === 'string' && r[dateField] >= cutoffDate);
}

/**
 * fundamentals_history is annual-cadence data, not daily -- a strict
 * date-based rolling cutoff (like price_history uses) doesn't map cleanly
 * onto it, because an audited disclosure for fiscal year N is typically
 * published many months into year N+1. Applying the same "last 183 days"
 * cutoff to fiscal_year would hide most companies' most recent real
 * disclosure from free users, which isn't the intent (give a real taste,
 * not near-total lockout). Instead: free users get the single most recent
 * fiscal year per symbol; the multi-year archive is what's paid. Rows are
 * assumed pre-sorted newest-first (matches getCompanyFundamentalsHistory's
 * `ORDER BY fiscal_year DESC`).
 */
export function limitToLatestFiscalYear(rows, isEntitled) {
  if (isEntitled) return rows;
  if (!Array.isArray(rows)) return rows;
  return rows.slice(0, 1);
}

/**
 * Gates a full getDetailedHistoricalAnalysis() result for a non-entitled
 * viewer. Kept visible regardless of entitlement: identity fields (symbol,
 * name, sector, category), TODAY's price (currentPrice/closeDate -- this is
 * live data, not archive, and live data was never part of the paywall), and
 * the generic macro catalysts/cycles content (static educational material,
 * not derived from this user's access to the archive). `timeline` is
 * truncated to the free window rather than blanked entirely, so a free
 * viewer still sees a real (if partial) chart. Everything that fundamentally
 * requires the full multi-year archive to mean anything --
 * ATH/ATL/drawdown/SMA200 trend/valuation percentile/mean reversion/Graham
 * number/the audited disclosures block/full financial statement history --
 * gets nulled rather than recomputed on a truncated window: a "6-month
 * all-time-high" or an SMA200 computed from ~125 trading days would be
 * silently wrong in a way this project doesn't allow anywhere else, so
 * these are locked outright instead of quietly degraded.
 */
export function applyDeepDiveGate(analysisResult, isEntitled, cutoffDate) {
  if (isEntitled || !analysisResult) return analysisResult;

  const timeline = Array.isArray(analysisResult.timeline)
    ? analysisResult.timeline.filter(pt => typeof pt?.date === 'string' && pt.date >= cutoffDate)
    : analysisResult.timeline;

  return {
    ...analysisResult,
    ...buildLockedMeta(cutoffDate),
    timeline,
    ath: null,
    atl: null,
    maxDrawdown: null,
    technical: null,
    valuationCorridor: null,
    meanReversion: null,
    grahamAndBuffett: null,
    disclosures: null,
    financialStatements: [],
    // Added 2026-08-24 alongside the pro-investor analytics block in
    // getDetailedHistoricalAnalysis -- all of these are either computed from
    // more than the free rolling window's worth of price history (riskMetrics,
    // returnsTable, week52, liquidity), span multiple audited fiscal years
    // (fundamentalsGrowth, sectorPercentileTrend), or are a current disclosed
    // snapshot in the same category as `disclosures` above (shareholding).
    // None of these existed when this function was first written -- a new
    // field added to analysisResult here must always get a decision made
    // for it in this list, never just inherit "free" by omission.
    riskMetrics: null,
    returnsTable: [],
    fundamentalsGrowth: null,
    week52: null,
    liquidity: null,
    sectorPercentileTrend: [],
    shareholding: null,
  };
}
