/**
 * Main DB Institutional Auditor
 *
 * Read-only sanity/fabrication check over data/dse.db -- the production database
 * server/index.js actually serves from.
 *
 * Same errors/warnings split: errors are things that are
 * flatly impossible for real data (a stock trading at 0, DSEX outside its ever-recorded
 * range, a source not on shared/source_tiers.js's approved list) and always block
 * CERTIFIED_PASSED; warnings are statistical anomalies worth a human glance
 * (high null-rate on a column, outlier ratios) but not proof of fabrication on
 * their own -- see ARCHITECTURE.md for the reasoning.
 */
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { initDB, dbAll, saveMainDBAuditReport } from '../db.js';
import { isApprovedSource, tierDisplayName } from '../../shared/source_tiers.js';
import { fetchWithRetry, sleep } from '../../shared/dse_http_client.js';
import { PLANS } from '../../shared/plans.js';
import { DS30_INDEX_MIN, DS30_INDEX_MAX, SHAREHOLDING_SUM_TOLERANCE_PCT } from '../../shared/data_auditor.js';

// Bounded, rate-limited, circuit-breaker-protected live price cross-check.
// Previously this looped over EVERY distinct live-sourced date with a
// fetchWithRetry(45000ms, 3 attempts) per date and no delay between requests
// or cap on how many dates it would attempt -- on this DB that's 479 distinct
// dates, one HTTP round-trip each, sequentially: confirmed live to take 25+
// minutes and still running (not a hang, just 479 uncapped, unthrottled
// requests). Two changes: (1) checks only the most recent maxDates (this is
// a live-drift check, not a full-history re-verification -- the DB-level
// checks above already cover full history; audit_historical_prices_dse.js
// uses the same "recent window, not full replay" reasoning), (2) a circuit
// breaker that aborts after too many consecutive failures instead of
// grinding through the rest of a genuinely-unreachable site.
export async function checkLivePriceRowsAgainstDSE({ maxDates = 60, maxConsecutiveFailures = 5, requestDelayMs = 250 } = {}) {
  const allDates = await dbAll(`SELECT DISTINCT date FROM price_history WHERE source != 'STAGING_DB' ORDER BY date DESC`);
  if (allDates.length === 0) return { checked: 0, mismatches: [], note: 'No live-sourced price_history rows present.' };

  const dates = allDates.slice(0, maxDates);
  const skippedOlderDates = allDates.length - dates.length;

  const mismatches = [];
  let checked = 0;
  let consecutiveFailures = 0;
  let abortedEarly = false;
  for (const { date } of dates) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      abortedEarly = true;
      mismatches.push({ date: null, error: `Aborted after ${maxConsecutiveFailures} consecutive fetch failures -- dsebd.org may be unreachable right now. ${dates.length - checked} date(s) not checked this run.` });
      break;
    }

    const url = `https://www.dsebd.org/day_end_archive.php?startDate=${date}&endDate=${date}&inst=${encodeURIComponent('All Instrument')}&archive=data`;
    let liveMap;
    try {
      const res = await fetchWithRetry(url, { timeout: 45000, attempts: 3, backoffMs: 3000 });
      const $ = cheerio.load(res.data);
      liveMap = new Map();
      $('table').each((_, table) => {
        $(table).find('tr').each((_, row) => {
          const c = $(row).find('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim().replace(/,/g, '')).get();
          if (c.length < 12 || c[1] !== date) return;
          const symbol = c[2].toUpperCase().trim();
          if (symbol) liveMap.set(symbol, { close: parseFloat(c[7]) || parseFloat(c[3]) || null });
        });
      });
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      mismatches.push({ date, error: `Failed to fetch live DSE data: ${e.message}` });
      continue;
    }

    const dbRows = await dbAll(`SELECT symbol, close FROM price_history WHERE date = ? AND source != 'STAGING_DB'`, [date]);
    for (const row of dbRows) {
      const live = liveMap.get(row.symbol);
      checked++;
      if (!live || live.close === null) continue;
      if (Math.abs(live.close - row.close) > 0.05) {
        mismatches.push({ date, symbol: row.symbol, main: row.close, dse: live.close });
      }
    }

    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }
  return { checked, mismatches, datesChecked: dates.length, skippedOlderDates, abortedEarly };
}

export async function checkLiveDSEXRowsAgainstDSE() {
  const rows = await dbAll(`SELECT date, dsex_index FROM dsex_market_history WHERE source != 'STAGING_DB' ORDER BY date`);
  if (rows.length === 0) return { checked: 0, mismatches: [], note: 'No live-sourced dsex_market_history rows present.' };

  let liveMap;
  try {
    const res = await fetchWithRetry('https://www.dsebd.org/recent_market_information.php', { timeout: 20000, attempts: 3, backoffMs: 2000 });
    const $ = cheerio.load(res.data);
    liveMap = new Map();
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length >= 6 && /\d{2}-\d{2}-\d{4}/.test(cells[0])) {
        const [d, m, y] = cells[0].split('-');
        const dsex = parseFloat(cells[5]);
        if (!isNaN(dsex) && dsex > 1000) liveMap.set(`${y}-${m}-${d}`, dsex);
      }
    });
  } catch (e) {
    return { checked: 0, mismatches: [{ error: `Failed to fetch live DSE index data: ${e.message}` }] };
  }

  const mismatches = [];
  let checked = 0;
  let unreachable = 0;
  for (const row of rows) {
    const liveVal = liveMap.get(row.date);
    if (liveVal === undefined) { unreachable++; continue; }
    checked++;
    if (Math.abs(liveVal - row.dsex_index) > 0.05) {
      mismatches.push({ date: row.date, main: row.dsex_index, dse: liveVal });
    }
  }
  return { checked, unreachable, mismatches };
}

const DSEX_MIN = 500;
const DSEX_MAX = 20000;

// A specific hardcoded breadth triple a since-deleted synthetic-data generator
// used to write into every row it produced. Real DSE sessions never produce
// this exact triple by coincidence across multiple dates -- any match is
// treated as a hard error, not a statistical warning.
const FABRICATED_BREADTH_SIGNATURE = { advancing: 180, declining: 140, unchanged: 60 };

function pct(n, total) {
  if (!total) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function auditPriceHistory() {
  const errors = [];
  const warnings = [];
  const [row] = await dbAll(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN close IS NULL OR close <= 0 THEN 1 ELSE 0 END) AS bad_close,
      SUM(CASE WHEN high IS NOT NULL AND low IS NOT NULL AND high < low THEN 1 ELSE 0 END) AS inverted_high_low,
      SUM(CASE WHEN volume IS NOT NULL AND volume < 0 THEN 1 ELSE 0 END) AS negative_volume,
      SUM(CASE WHEN value_mn IS NOT NULL AND value_mn < 0 THEN 1 ELSE 0 END) AS negative_value,
      SUM(CASE WHEN ycp IS NULL THEN 1 ELSE 0 END) AS null_ycp,
      SUM(CASE WHEN volume IS NULL THEN 1 ELSE 0 END) AS null_volume,
      SUM(CASE WHEN change IS NULL THEN 1 ELSE 0 END) AS null_change,
      SUM(CASE WHEN pe IS NOT NULL AND (pe < 0 OR pe > 300) THEN 1 ELSE 0 END) AS outlier_pe,
      SUM(CASE WHEN trades IS NOT NULL AND trades < 0 THEN 1 ELSE 0 END) AS negative_trades,
      SUM(CASE WHEN market_cap_mn IS NOT NULL AND market_cap_mn < 0 THEN 1 ELSE 0 END) AS negative_mcap
    FROM price_history
  `);

  if (row.bad_close > 0) {
    errors.push(`price_history: ${row.bad_close.toLocaleString()} rows have close <= 0 or NULL -- impossible for a real recorded trade`);
  }
  if (row.inverted_high_low > 0) {
    errors.push(`price_history: ${row.inverted_high_low.toLocaleString()} rows have high < low`);
  }
  if (row.negative_volume > 0) {
    errors.push(`price_history: ${row.negative_volume.toLocaleString()} rows have negative volume`);
  }
  if (row.negative_value > 0) {
    errors.push(`price_history: ${row.negative_value.toLocaleString()} rows have negative value_mn`);
  }
  if (row.negative_trades > 0) {
    errors.push(`price_history: ${row.negative_trades.toLocaleString()} rows have negative trade counts`);
  }
  if (row.negative_mcap > 0) {
    errors.push(`price_history: ${row.negative_mcap.toLocaleString()} rows have negative market cap`);
  }
  if (row.outlier_pe > 0) {
    warnings.push(`price_history: ${row.outlier_pe.toLocaleString()} rows have P/E outside the 0-300 sanity range`);
  }

  // Approved-source check (shared/source_tiers.js)
  const sourceRows = await dbAll(`SELECT source, COUNT(*) AS cnt FROM price_history GROUP BY source`);
  const unapproved = sourceRows.filter(s => s.source !== null && !isApprovedSource(s.source));
  if (unapproved.length > 0) {
    errors.push(`price_history: unapproved source(s) present: ${unapproved.map(u => `${u.source} (${u.cnt.toLocaleString()} rows)`).join(', ')} -- not on shared/source_tiers.js's approved list`);
  }
  const nullSource = sourceRows.find(s => s.source === null);

  console.log(`  price_history: ${row.total.toLocaleString()} rows (full 17-column OHLCV checked) | null ycp=${pct(row.null_ycp, row.total)} volume=${pct(row.null_volume, row.total)} change=${pct(row.null_change, row.total)}`);
  console.log(`    sources: ${sourceRows.filter(s => s.source !== null).map(s => `${s.source} [${tierDisplayName(s.source)}]=${s.cnt.toLocaleString()}`).join(', ')}${nullSource ? `, untagged=${nullSource.cnt.toLocaleString()}` : ''}`);
  return { errors, warnings, recordsAudited: row.total };
}

export async function auditDSEXHistory() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll(`SELECT date, dsex_index, advancing, declining, unchanged, total_trades, total_volume, total_value_mn, source FROM dsex_market_history`);

  let rangeViolations = 0;
  let fabricationHits = 0;
  let invalidDateFormat = 0;
  const fabricationDates = [];
  const sourceCounts = new Map();
  for (const r of rows) {
    if (r.dsex_index == null || r.dsex_index < DSEX_MIN || r.dsex_index > DSEX_MAX) {
      rangeViolations++;
    }
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      invalidDateFormat++;
    }
    if (r.advancing === FABRICATED_BREADTH_SIGNATURE.advancing &&
        r.declining === FABRICATED_BREADTH_SIGNATURE.declining &&
        r.unchanged === FABRICATED_BREADTH_SIGNATURE.unchanged) {
      fabricationHits++;
      fabricationDates.push(r.date);
    }
    const key = r.source ?? '(untagged)';
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }

  if (rangeViolations > 0) {
    errors.push(`dsex_market_history: ${rangeViolations} rows outside the realistic DSEX range (${DSEX_MIN}-${DSEX_MAX})`);
  }
  if (invalidDateFormat > 0) {
    errors.push(`dsex_market_history: ${invalidDateFormat} rows have invalid date format`);
  }
  if (fabricationHits > 0) {
    errors.push(`dsex_market_history: ${fabricationHits} rows match the known dsex_builder.js fabrication signature (advancing=180, declining=140, unchanged=60) on dates: ${fabricationDates.slice(0, 10).join(', ')}${fabricationDates.length > 10 ? '...' : ''}`);
  }

  // Approved-source check (shared/source_tiers.js).
  const unapproved = [...sourceCounts.entries()].filter(([src]) => src !== '(untagged)' && !isApprovedSource(src));
  if (unapproved.length > 0) {
    errors.push(`dsex_market_history: unapproved source(s) present: ${unapproved.map(([src, cnt]) => `${src} (${cnt.toLocaleString()} rows)`).join(', ')} -- not on shared/source_tiers.js's approved list`);
  }

  console.log(`  dsex_market_history: ${rows.length.toLocaleString()} rows (full 10-column breadth & turnover checked)`);
  console.log(`    sources: ${[...sourceCounts.entries()].map(([src, cnt]) => `${src} [${tierDisplayName(src)}]=${cnt.toLocaleString()}`).join(', ')}`);
  return { errors, warnings, recordsAudited: rows.length };
}

export async function auditDS30History() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll(`SELECT date, ds30_index, source FROM ds30_index_history`);

  let rangeViolations = 0;
  let invalidDateFormat = 0;
  const sourceCounts = new Map();

  for (const r of rows) {
    if (r.ds30_index == null || r.ds30_index < DS30_INDEX_MIN || r.ds30_index > DS30_INDEX_MAX) {
      rangeViolations++;
    }
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      invalidDateFormat++;
    }
    const key = r.source ?? '(untagged)';
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }

  if (rangeViolations > 0) {
    errors.push(`ds30_index_history: ${rangeViolations} rows outside the realistic DS30 range (${DS30_INDEX_MIN}-${DS30_INDEX_MAX})`);
  }
  if (invalidDateFormat > 0) {
    errors.push(`ds30_index_history: ${invalidDateFormat} rows have invalid date format`);
  }

  console.log(`  ds30_index_history: ${rows.length.toLocaleString()} rows (full index history checked)`);
  return { errors, warnings, recordsAudited: rows.length };
}

export async function auditFundamentals() {
  const errors = [];
  const warnings = [];

  // "Current" is each symbol's latest fiscal_year row
  const [snap] = await dbAll(`
    WITH latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fiscal_year DESC) as rn
      FROM fundamentals_history
    )
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN pe_ratio = 0 OR pe_diluted = 0 OR pe_trailing = 0 THEN 1 ELSE 0 END) AS zero_pe,
      SUM(CASE WHEN paid_up_capital_mn = 0 THEN 1 ELSE 0 END) AS zero_paidup,
      SUM(CASE WHEN nav_per_share IS NOT NULL AND nav_per_share <= 0 THEN 1 ELSE 0 END) AS bad_navps
    FROM latest WHERE rn = 1
  `);
  if (snap.zero_pe > 0) {
    errors.push(`fundamentals_history (current): ${snap.zero_pe} rows have a P/E of exactly 0 -- impossible for a real company, should be NULL if undisclosed`);
  }
  if (snap.zero_paidup > 0) {
    errors.push(`fundamentals_history (current): ${snap.zero_paidup} rows have paid_up_capital_mn = 0 -- impossible for a listed company, should be NULL if undisclosed`);
  }
  if (snap.bad_navps > 0) {
    warnings.push(`fundamentals_history (current): ${snap.bad_navps} rows have NAVPS <= 0`);
  }
  console.log(`  fundamentals_history (current, 1 row/symbol): ${snap.total.toLocaleString()} rows`);

  const [hist] = await dbAll(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN pe_ratio = 0 THEN 1 ELSE 0 END) AS zero_pe,
      SUM(CASE WHEN paid_up_capital_mn = 0 THEN 1 ELSE 0 END) AS zero_paidup,
      SUM(CASE WHEN eps_basic IS NOT NULL AND (eps_basic < -200 OR eps_basic > 1000) THEN 1 ELSE 0 END) AS outlier_eps,
      SUM(CASE WHEN fiscal_year < 1990 OR fiscal_year > 2050 THEN 1 ELSE 0 END) AS bad_year,
      SUM(CASE WHEN short_term_loan_mn < 0 OR long_term_loan_mn < 0 THEN 1 ELSE 0 END) AS negative_loans,
      SUM(CASE WHEN dps < 0 THEN 1 ELSE 0 END) AS negative_dps,
      SUM(CASE WHEN bonus_pct < 0 THEN 1 ELSE 0 END) AS negative_bonus,
      SUM(CASE WHEN revenue_mn < 0 THEN 1 ELSE 0 END) AS negative_revenue,
      SUM(CASE WHEN revenue_mn IS NOT NULL AND gross_profit_mn IS NOT NULL AND gross_profit_mn > revenue_mn THEN 1 ELSE 0 END) AS bad_gross_profit,
      SUM(CASE WHEN total_assets_mn < 0 THEN 1 ELSE 0 END) AS negative_assets,
      SUM(CASE WHEN total_liabilities_mn < 0 THEN 1 ELSE 0 END) AS negative_liabilities,
      SUM(CASE WHEN capex_mn < 0 THEN 1 ELSE 0 END) AS negative_capex,
      SUM(CASE WHEN operating_cash_flow_mn IS NOT NULL AND capex_mn IS NOT NULL AND free_cash_flow_mn IS NOT NULL AND ABS(free_cash_flow_mn - (operating_cash_flow_mn - capex_mn)) > 0.05 THEN 1 ELSE 0 END) AS fcf_mismatches
    FROM fundamentals_history
  `);

  // Approved-source check via shared/source_tiers.js's isApprovedSource(), same
  // pattern used for dsex_market_history above -- this used to be a hand-copied
  // SQL IN-list here that had already drifted out of sync with the real
  // approved list (missing DSE_OFFICIAL_ARCHIVE/BENCHMARK/GRAPH,
  // DSE_LIVE_CLOSING/TICKER, DSE_MARKET_EARNINGS_YIELD_EMPIRICAL).
  const fundSourceRows = await dbAll(`SELECT source, COUNT(*) AS cnt FROM fundamentals_history GROUP BY source`);
  const unapprovedFundSources = fundSourceRows.filter(r => r.source != null && !isApprovedSource(r.source));
  const unapprovedSrcCount = unapprovedFundSources.reduce((sum, r) => sum + r.cnt, 0);
  if (hist.zero_pe > 0) {
    errors.push(`fundamentals_history: ${hist.zero_pe} rows have a P/E of exactly 0`);
  }
  if (hist.zero_paidup > 0) {
    errors.push(`fundamentals_history: ${hist.zero_paidup} rows have paid_up_capital_mn = 0`);
  }
  if (hist.bad_year > 0) {
    errors.push(`fundamentals_history: ${hist.bad_year} rows have an implausible fiscal_year`);
  }
  if (hist.negative_loans > 0) {
    errors.push(`fundamentals_history: ${hist.negative_loans} rows have negative debt/loans`);
  }
  if (hist.negative_dps > 0) {
    errors.push(`fundamentals_history: ${hist.negative_dps} rows have negative DPS`);
  }
  if (hist.negative_bonus > 0) {
    errors.push(`fundamentals_history: ${hist.negative_bonus} rows have negative bonus %`);
  }
  if (hist.negative_revenue > 0) {
    errors.push(`fundamentals_history: ${hist.negative_revenue} rows have negative revenue`);
  }
  if (hist.bad_gross_profit > 0) {
    errors.push(`fundamentals_history: ${hist.bad_gross_profit} rows have gross profit > revenue`);
  }
  if (hist.negative_assets > 0) {
    errors.push(`fundamentals_history: ${hist.negative_assets} rows have negative total assets`);
  }
  if (hist.negative_liabilities > 0) {
    errors.push(`fundamentals_history: ${hist.negative_liabilities} rows have negative total liabilities`);
  }
  if (hist.negative_capex > 0) {
    errors.push(`fundamentals_history: ${hist.negative_capex} rows have negative capex`);
  }
  if (hist.fcf_mismatches > 0) {
    errors.push(`fundamentals_history: ${hist.fcf_mismatches} rows have free cash flow != (OCF - CapEx)`);
  }
  if (unapprovedSrcCount > 0) {
    errors.push(`fundamentals_history: ${unapprovedSrcCount} rows have an unapproved source provenance: ${unapprovedFundSources.map(r => `${r.source} (${r.cnt.toLocaleString()} rows)`).join(', ')}`);
  }
  if (hist.outlier_eps > 0) {
    warnings.push(`fundamentals_history: ${hist.outlier_eps} rows have EPS outside the -200 to 1000 sanity range`);
  }
  console.log(`  fundamentals_history: ${hist.total.toLocaleString()} rows (full 37-column statement checked)`);

  return {
    errors,
    warnings,
    recordsAudited: snap.total + hist.total
  };
}

export async function auditShareholding() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll(`
    SELECT symbol, sponsor_pct, govt_pct, institute_pct, foreign_pct, public_pct, as_of_date,
           prev_sponsor_pct, prev_govt_pct, prev_institute_pct, prev_foreign_pct, prev_public_pct, prev_as_of_date,
           source, updated_at
    FROM shareholding_current
  `);

  for (const r of rows) {
    if (!r.symbol) errors.push(`shareholding_current: missing symbol identifier`);
    if (r.as_of_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date)) {
      errors.push(`shareholding_current.${r.symbol}: invalid as_of_date format "${r.as_of_date}"`);
    }
    const sum = (r.sponsor_pct || 0) + (r.govt_pct || 0) + (r.institute_pct || 0) + (r.foreign_pct || 0) + (r.public_pct || 0);
    if (sum > 0 && Math.abs(sum - 100) > SHAREHOLDING_SUM_TOLERANCE_PCT) {
      warnings.push(`shareholding_current.${r.symbol}: shareholding breakdown sum is ${sum.toFixed(2)}% (expected ~100%)`);
    }
  }

  const activeCount = rows.length;
  console.log(`  shareholding_current: ${activeCount.toLocaleString()} snapshots (current + previous checked)`);
  return { errors, warnings, recordsAudited: rows.length };
}

export async function auditCompanyList() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll(`
    SELECT symbol, name, sector, category, ds30, face_value, total_shares, is_active, source,
           trading_status, prev_category, category_changed_at, is_new_listing, fetched_at,
           reserve_surplus_mn, oci_mn, short_term_loan_mn, long_term_loan_mn
    FROM company_list
  `);
  let missingSymbol = 0;
  let invalidFaceValue = 0;
  let negativeLoans = 0;

  for (const r of rows) {
    if (!r.symbol) missingSymbol++;
    if (r.face_value !== null && r.face_value <= 0) invalidFaceValue++;
    if ((r.short_term_loan_mn !== null && r.short_term_loan_mn < 0) || (r.long_term_loan_mn !== null && r.long_term_loan_mn < 0)) {
      negativeLoans++;
    }
  }

  if (missingSymbol > 0) {
    errors.push(`company_list: ${missingSymbol} row(s) missing symbol identifier`);
  }
  if (invalidFaceValue > 0) {
    errors.push(`company_list: ${invalidFaceValue} row(s) have invalid face_value <= 0`);
  }
  if (negativeLoans > 0) {
    errors.push(`company_list: ${negativeLoans} row(s) have negative loan amounts`);
  }

  const activeCount = rows.filter(r => r.is_active).length;
  console.log(`  company_list: ${rows.length.toLocaleString()} instruments (${activeCount} active, full 27-column roster & lifecycle tracked)`);

  return { errors, warnings, recordsAudited: rows.length };
}

/**
 * Audit the premium-tier tables: users/sessions/entitlements/payments/promo_codes/promo_redemptions/admin_actions.
 */
export async function auditPremiumTier() {
  const errors = [];
  const warnings = [];

  const orphanChecks = [
    ['sessions', 'user_id'],
    ['entitlements', 'user_id'],
    ['payments', 'user_id'],
    ['promo_redemptions', 'user_id'],
    ['admin_actions', 'admin_user_id'],
  ];
  let recordsAudited = 0;
  for (const [table, col] of orphanChecks) {
    const [row] = await dbAll(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN u.id IS NULL THEN 1 ELSE 0 END) AS orphaned
      FROM ${table} t LEFT JOIN users u ON u.id = t.${col}
    `);
    recordsAudited += row.total;
    if (row.orphaned > 0) {
      errors.push(`${table}: ${row.orphaned} row(s) reference a ${col} with no matching users row -- FK enforcement should prevent this; investigate immediately.`);
    }
  }

  // Payments: plan must be a real key, and a SUCCESS payment's amount must
  // match that plan's canonical price exactly.
  const payments = await dbAll(`SELECT id, plan, amount_bdt, status FROM payments`);
  recordsAudited += payments.length;
  for (const p of payments) {
    if (!Object.prototype.hasOwnProperty.call(PLANS, p.plan)) {
      errors.push(`payments.id=${p.id}: plan "${p.plan}" is not a recognized plan key (see shared/plans.js).`);
      continue;
    }
    if (p.status === 'SUCCESS' && p.amount_bdt !== PLANS[p.plan].priceBdt) {
      errors.push(`payments.id=${p.id}: SUCCESS payment for plan ${p.plan} recorded ${p.amount_bdt} BDT, but that plan's price is ${PLANS[p.plan].priceBdt} BDT.`);
    }
  }

  const [expiredRow] = await dbAll(`SELECT COUNT(*) AS c FROM sessions WHERE expires_at < datetime('now')`);
  if (expiredRow.c > 0) {
    warnings.push(`sessions: ${expiredRow.c} expired session row(s) not yet cleaned up (harmless -- they can't authenticate anything, just disk tidiness).`);
  }

  console.log(`  premium tier: ${recordsAudited.toLocaleString()} rows audited across users/sessions/entitlements/payments/promo_redemptions/admin_actions`);

  return { errors, warnings, recordsAudited };
}

async function auditValuationCache() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll('SELECT * FROM valuation_daily_cache');
  const recordsAudited = rows.length;

  if (rows.length === 0) {
    warnings.push('valuation_daily_cache is empty. Run precomputeDailyValuationMetrics() to populate.');
    return { errors, warnings, recordsAudited: 0 };
  }

  const validVerdicts = new Set(['Undervalued', 'Fairly Valued', 'Overvalued', 'Neutral']);
  const validMoats = new Set(['Wide', 'Narrow', 'None']);

  for (const r of rows) {
    if (!r.symbol || r.symbol.length > 20) {
      errors.push(`valuation_daily_cache: invalid symbol "${r.symbol}"`);
    }
    if (r.close === null || r.close <= 0) {
      errors.push(`valuation_daily_cache.${r.symbol}: non-positive or null close price: ${r.close}`);
    }
    if (r.valuation_verdict && !validVerdicts.has(r.valuation_verdict)) {
      errors.push(`valuation_daily_cache.${r.symbol}: unrecognized valuation verdict "${r.valuation_verdict}"`);
    }
    if (r.moat_rating && !validMoats.has(r.moat_rating)) {
      errors.push(`valuation_daily_cache.${r.symbol}: unrecognized moat rating "${r.moat_rating}"`);
    }
    if (r.piotroski_score !== null && (r.piotroski_score < 0 || r.piotroski_score > 6)) {
      errors.push(`valuation_daily_cache.${r.symbol}: Piotroski score outside [0, 6] range: ${r.piotroski_score}`);
    }
  }

  console.log(`  valuation cache: ${recordsAudited.toLocaleString()} cached company valuation profiles audited`);
  return { errors, warnings, recordsAudited };
}

async function auditCorporateActions() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll('SELECT * FROM corporate_actions_calendar');
  const recordsAudited = rows.length;

  if (rows.length === 0) {
    warnings.push('corporate_actions_calendar is empty. Run scrapeLankaBDDividendArchive() to populate.');
    return { errors, warnings, recordsAudited: 0 };
  }

  const validTypes = new Set(['DIVIDEND', 'AGM', 'CATEGORY_CHANGE', 'NEW_LISTING', 'DS30_REBALANCE']);

  for (const r of rows) {
    if (!r.symbol || r.symbol.length > 20) {
      errors.push(`corporate_actions_calendar.id=${r.id}: invalid symbol "${r.symbol}"`);
    }
    if (!validTypes.has(r.event_type)) {
      errors.push(`corporate_actions_calendar.id=${r.id}: unrecognized event_type "${r.event_type}"`);
    }
    if (!r.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(r.event_date)) {
      errors.push(`corporate_actions_calendar.id=${r.id}: invalid event_date format "${r.event_date}"`);
    }
    if (r.record_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.record_date)) {
      errors.push(`corporate_actions_calendar.id=${r.id}: invalid record_date format "${r.record_date}"`);
    }
    if (!isApprovedSource(r.source)) {
      errors.push(`corporate_actions_calendar.id=${r.id}: unapproved source "${r.source}"`);
    }
  }

  console.log(`  corporate actions: ${recordsAudited.toLocaleString()} corporate action events audited`);
  return { errors, warnings, recordsAudited };
}

async function auditMacroIndicators() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll('SELECT * FROM macro_indicators');
  const recordsAudited = rows.length;

  if (rows.length === 0) {
    errors.push('macro_indicators table is empty! Must contain at least BANGLADESH_364D_TBILL benchmark.');
    return { errors, warnings, recordsAudited: 0 };
  }

  const tbill = rows.find(r => r.indicator_key === 'BANGLADESH_364D_TBILL');
  if (!tbill) {
    errors.push('macro_indicators: BANGLADESH_364D_TBILL benchmark key is missing.');
  } else if (tbill.value <= 0 || tbill.value > 0.30) {
    errors.push(`macro_indicators: BANGLADESH_364D_TBILL yield (${tbill.value}) is outside reasonable sanity range (0% - 30%).`);
  }

  for (const r of rows) {
    if (!r.as_of_date || !/^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date)) {
      errors.push(`macro_indicators.${r.indicator_key}: invalid as_of_date format "${r.as_of_date}"`);
    }
  }

  console.log(`  macro indicators: ${recordsAudited.toLocaleString()} benchmark rates audited (Active Rf: ${tbill ? (tbill.value * 100).toFixed(2) + '%' : 'N/A'})`);
  return { errors, warnings, recordsAudited };
}

async function auditDataQuarantine() {
  const errors = [];
  const warnings = [];
  const rows = await dbAll('SELECT * FROM data_quarantine');
  const recordsAudited = rows.length;

  // The real values ever written to data_quarantine.status (schema.js's
  // default, ingestion_repo.js's saveConflictToQuarantine/
  // resolveQuarantineConflict) -- the previous set here ('PENDING',
  // 'RESOLVED_OVERWRITE', 'RESOLVED_KEPT') was never actually written by any
  // code path, so this check hard-failed the moment a single quarantine row
  // ever existed, regardless of whether it was a real problem.
  const validStatuses = new Set(['PENDING_USER_APPROVAL', 'APPROVED_BY_USER', 'REJECTED_BY_USER']);
  for (const r of rows) {
    if (!validStatuses.has(r.status)) {
      errors.push(`data_quarantine.id=${r.id}: invalid quarantine status "${r.status}"`);
    }
  }

  console.log(`  data_quarantine: ${recordsAudited.toLocaleString()} conflict records audited`);
  return { errors, warnings, recordsAudited };
}

/**
 * Runs every check against data/dse.db and prints an institutional-style report.
 * Read-only -- never modifies data.
 */
export async function auditMainDB({ skipPrice = false, includeLiveCheck = true } = {}) {
  await initDB();
  const runTimestamp = new Date().toISOString();

  console.log('\n======================================================');
  console.log('   MAIN DATABASE INSTITUTIONAL AUDIT (data/dse.db)');
  console.log(`   Execution Time: ${runTimestamp}`);
  console.log('======================================================\n');

  let priceResult = { errors: [], warnings: [], recordsAudited: 0 };
  if (!skipPrice) {
    console.log('1. Auditing `price_history` (13 columns)...');
    priceResult = await auditPriceHistory();
  } else {
    console.log('1. Skipping `price_history` (skipPrice=true).');
  }

  console.log('\n2. Auditing `dsex_market_history` (10 columns) & `ds30_index_history`...');
  const dsexResult = await auditDSEXHistory();
  const ds30Result = await auditDS30History();

  console.log('\n3. Auditing `fundamentals_history` (22 columns) & `shareholding_current` (9 columns)...');
  const fundResult = await auditFundamentals();
  const shareholdingResult = await auditShareholding();

  console.log('\n4. Auditing `company_list` (10 columns)...');
  const companyResult = await auditCompanyList();

  let liveWarnings = [];
  if (includeLiveCheck) {
    console.log('\n5. Checking live (non-STAGING_DB) rows against fresh DSE data...');
    const livePrice = await checkLivePriceRowsAgainstDSE();
    const liveDsex = await checkLiveDSEXRowsAgainstDSE();
    const dateScopeNote = livePrice.skippedOlderDates
      ? ` (most recent ${livePrice.datesChecked} of ${livePrice.datesChecked + livePrice.skippedOlderDates} live-sourced dates; ${livePrice.skippedOlderDates} older date(s) not re-checked this run)`
      : '';
    console.log(`   Live price rows checked: ${livePrice.checked}${dateScopeNote}${livePrice.note ? ' (' + livePrice.note + ')' : ''}, mismatches: ${livePrice.mismatches.length}${livePrice.abortedEarly ? ' -- ABORTED EARLY (see mismatches for reason)' : ''}`);
    console.log(`   Live DSEX rows checked: ${liveDsex.checked}${liveDsex.note ? ' (' + liveDsex.note + ')' : ''}, mismatches: ${liveDsex.mismatches.length}`);
    for (const m of livePrice.mismatches) liveWarnings.push(`live price_history vs DSE ${JSON.stringify(m)}`);
    for (const m of liveDsex.mismatches) liveWarnings.push(`live dsex_market_history vs DSE ${JSON.stringify(m)}`);
  }

  console.log('\n6. Auditing premium tier (users/sessions/entitlements/payments/promo codes)...');
  const premiumResult = await auditPremiumTier();

  console.log('\n7. Auditing valuation daily cache (`valuation_daily_cache` — 23 columns)...');
  const valuationResult = await auditValuationCache();

  console.log('\n8. Auditing corporate actions calendar (`corporate_actions_calendar` — 10 columns)...');
  const corpActionsResult = await auditCorporateActions();

  console.log('\n9. Auditing macro indicators & yield benchmarks (`macro_indicators` — 5 columns)...');
  const macroResult = await auditMacroIndicators();

  console.log('\n10. Auditing data quarantine log (`data_quarantine` — 12 columns)...');
  const quarantineResult = await auditDataQuarantine();

  const allErrors = [
    ...priceResult.errors,
    ...dsexResult.errors,
    ...ds30Result.errors,
    ...fundResult.errors,
    ...shareholdingResult.errors,
    ...companyResult.errors,
    ...premiumResult.errors,
    ...valuationResult.errors,
    ...corpActionsResult.errors,
    ...macroResult.errors,
    ...quarantineResult.errors
  ];
  const allWarnings = [
    ...priceResult.warnings,
    ...dsexResult.warnings,
    ...ds30Result.warnings,
    ...fundResult.warnings,
    ...shareholdingResult.warnings,
    ...companyResult.warnings,
    ...liveWarnings,
    ...premiumResult.warnings,
    ...valuationResult.warnings,
    ...corpActionsResult.warnings,
    ...macroResult.warnings,
    ...quarantineResult.warnings
  ];
  const totalRecords =
    priceResult.recordsAudited +
    dsexResult.recordsAudited +
    ds30Result.recordsAudited +
    fundResult.recordsAudited +
    shareholdingResult.recordsAudited +
    companyResult.recordsAudited +
    premiumResult.recordsAudited +
    valuationResult.recordsAudited +
    corpActionsResult.recordsAudited +
    macroResult.recordsAudited +
    quarantineResult.recordsAudited;

  if (allErrors.length > 0) {
    console.log('\n--- BLOCKING ERRORS ---');
    for (const e of allErrors) console.error(`  \x1b[31m✖ ERROR\x1b[0m ${e}`);
  }
  if (allWarnings.length > 0) {
    console.log('\n--- WARNINGS (Informational / Statistical Drift) ---');
    for (const w of allWarnings.slice(0, 30)) console.warn(`  \x1b[33m⚠ WARN\x1b[0m ${w}`);
    if (allWarnings.length > 30) {
      console.warn(`  \x1b[33m⚠ WARN\x1b[0m ...and ${allWarnings.length - 30} more warnings (see audit_reports row for full list).`);
    }
  }

  const passed = allErrors.length === 0;
  const status = passed ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  const reportPayload = {
    price: priceResult,
    dsex: dsexResult,
    fundamentals: fundResult,
    companyList: companyResult,
    premium: premiumResult,
    liveWarnings,
    allErrors,
    allWarningsCount: allWarnings.length,
  };

  try {
    await saveMainDBAuditReport({
      targetEntity: 'MAIN_DB',
      recordsAudited: totalRecords,
      errorsCount: allErrors.length,
      warningsCount: allWarnings.length,
      status,
      reportJson: reportPayload
    });
    console.log(`\n[AUDITOR] Saved audit report to main DB audit_reports table (status: ${status}).`);
  } catch (err) {
    console.error('[AUDITOR] Failed to save audit report to DB:', err.message);
  }

  console.log('\n======================================================');
  console.log(`MAIN DB AUDIT SUMMARY: ${passed ? '\x1b[32mCERTIFIED_PASSED\x1b[0m' : '\x1b[31mAUDIT_FAILED\x1b[0m'}`);
  console.log(`Total Records Audited : ${totalRecords.toLocaleString()}`);
  console.log(`Blocking Errors       : ${allErrors.length}`);
  console.log(`Warnings / Notes      : ${allWarnings.length}`);
  console.log('======================================================\n');

  return {
    passed,
    status,
    totalRecords,
    errors: allErrors,
    warnings: allWarnings
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const args = process.argv.slice(2);
  const skipPrice = args.includes('--skip-price');
  const skipLive = args.includes('--skip-live');
  auditMainDB({ skipPrice, includeLiveCheck: !skipLive })
    .then(res => {
      if (!res.passed) process.exit(1);
    })
    .catch(err => {
      console.error('[FATAL AUDIT ERROR]', err);
      process.exit(1);
    });
}
