/**
 * Institutional Data Auditor & Sanity Validator -- the one gate every scraper
 * and every direct-to-main-DB write path runs its output through before a
 * write. One validator, one set of thresholds, used before every DB write in
 * this project, no exceptions.
 */
import { numOrNull, positiveNumOrNull, deriveOrNull, roundOrNull } from './safe_number.js';

// Shared sanity-range constants -- single source of truth so server/auditors/
// audit_main_database.js's post-write DB audit checks the exact same bands
// this pre-write gate does, instead of each file hand-copying its own value
// (found independently out of sync: audit_main_database.js was using a
// 300-15000 DS30 band and a +/-2.0 shareholding tolerance while this file
// used 500-8000 and +/-1.0 for the same two checks).
export const DS30_INDEX_MIN = 500;
export const DS30_INDEX_MAX = 8000; // DS30 has traded roughly 900-3600 since its 2013 launch (verified against the real dsebd.org monthly_graph_index.php?type=ds30 series 2026-08-25); generous headroom on both sides without being as loose as DSEX's own 500-20000 band.
export const SHAREHOLDING_SUM_TOLERANCE_PCT = 1.0; // DSE rounds each category to 2dp, so a few hundredths of drift is normal rounding, not a parsing bug.

export class DataAuditor {
  /**
   * Audit daily price history series for an equity
   */
  static auditPriceHistory(symbol, records = []) {
    const errors = [];
    const warnings = [];
    const cleanRecords = [];
    const seenDates = new Set();

    if (!records || !Array.isArray(records) || records.length === 0) {
      return {
        passed: false,
        symbol,
        errors: ['Price history is empty or not an array'],
        warnings,
        cleaned: []
      };
    }

    // Sort chronologically
    const sorted = [...records].sort((a, b) => new Date(a.trade_date || a.date) - new Date(b.trade_date || b.date));

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const dStr = String(r.trade_date || r.date || r.fetchedAt || '').slice(0, 10);
      const close = numOrNull(r.close ?? r.ltp) ?? 0;

      // Check 1: Date format validation
      if (!dStr || !/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
        errors.push(`Invalid date format at index ${i}: ${dStr}`);
        continue;
      }

      // Check 2: Prevent duplicates (Strictly 1 record per calendar date)
      if (seenDates.has(dStr)) {
        warnings.push(`Duplicate record for date ${dStr} filtered out`);
        continue;
      }
      seenDates.add(dStr);

      // Check 3: Positive price check
      if (close <= 0) {
        errors.push(`Non-positive close price on ${dStr}: ৳${close}`);
        continue;
      }

      // Check 4: Outlier single-day flash spike check (> 100% single session swing without corporate action)
      if (i > 0) {
        const prevClose = numOrNull(sorted[i - 1].close ?? sorted[i - 1].ltp) ?? close;
        if (prevClose > 0) {
          const ratio = close / prevClose;
          if (ratio > 3.0 || ratio < 0.25) {
            warnings.push(`Extreme price swing on ${dStr}: ৳${prevClose} -> ৳${close} (${((ratio - 1) * 100).toFixed(1)}%)`);
          }
        }
      }

      // Check 5: Valuation multiples sanity
      const pe = numOrNull(r.pe);
      if (pe !== null && (pe < 0 || pe > 300)) {
        warnings.push(`Unusual P/E on ${dStr}: ${pe}x`);
      }

      // No 0/close fallbacks: this project's whole sourcing policy is that a
      // genuinely unknown value stays null, never a fabricated "confirmed zero" or
      // (for ycp) a copy of today's close that would silently zero out change%.
      const ycpVal = numOrNull(r.ycp);
      cleanRecords.push({
        symbol: symbol.toUpperCase().trim(),
        date: dStr,
        trade_date: dStr,
        close,
        ltp: close,
        ycp: ycpVal,
        change: numOrNull(r.change) ?? deriveOrNull(close, ycpVal, (c, y) => y > 0 ? roundOrNull(c - y) : null),
        changePercent: numOrNull(r.changePercent) ?? deriveOrNull(close, ycpVal, (c, y) => y > 0 ? roundOrNull(((c - y) / y) * 100) : null),
        volume: numOrNull(r.volume),
        pe
      });
    }

    return {
      passed: errors.length === 0,
      symbol,
      totalInput: records.length,
      validRecords: cleanRecords.length,
      errors,
      warnings,
      cleaned: cleanRecords
    };
  }

  /**
   * Audit Annual Financial Statements
   */
  static auditFinancialStatements(symbol, statements = []) {
    const errors = [];
    const warnings = [];
    const cleanStatements = [];
    const seenYears = new Set();

    if (!statements || !Array.isArray(statements) || statements.length === 0) {
      return {
        passed: false,
        symbol,
        errors: ['Financial statements array is empty'],
        warnings,
        cleaned: []
      };
    }

    for (const stmt of statements) {
      const yr = parseInt(stmt.year || stmt.fiscal_year || 0);

      // Check 1: Valid year
      if (!yr || yr < 1990 || yr > 2050) {
        errors.push(`Invalid fiscal year: ${stmt.year || stmt.fiscal_year}`);
        continue;
      }

      if (seenYears.has(yr)) {
        warnings.push(`Duplicate report for FY${yr} filtered out`);
        continue;
      }
      seenYears.add(yr);

      const eps = numOrNull(stmt.eps);
      const navps = numOrNull(stmt.navps);
      // null, not a fabricated 0 -- P/E, P/B, and paid-up capital of literally 0 are
      // impossible for a real listed company, and an unstated ROE/dividend/bonus is
      // "not disclosed", not "confirmed zero". ROE is still derived from real
      // eps/navps when both are present -- that's exact arithmetic, not a guess.
      const roe = numOrNull(stmt.roe) ?? deriveOrNull(eps, navps, (e, n) => n > 0 ? roundOrNull((e / n) * 100) : null);

      if (eps !== null && (eps < -200 || eps > 1000)) {
        warnings.push(`Outlier EPS in FY${yr}: ৳${eps}`);
      }

      if (navps !== null && navps <= 0) {
        warnings.push(`FY${yr} NAVPS is negative or zero (৳${navps})`);
      }

      const dps = numOrNull(stmt.dps);
      const bonusPct = numOrNull(stmt.bonus_pct);
      const shortLoan = numOrNull(stmt.short_term_loan_mn);
      const longLoan = numOrNull(stmt.long_term_loan_mn);
      const revenueMn = numOrNull(stmt.revenue_mn ?? stmt.revenueMn);
      const grossProfitMn = numOrNull(stmt.gross_profit_mn ?? stmt.grossProfitMn);
      const operatingProfitMn = numOrNull(stmt.operating_profit_mn ?? stmt.operatingProfitMn);
      const totalAssetsMn = numOrNull(stmt.total_assets_mn ?? stmt.totalAssetsMn);
      const totalLiabilitiesMn = numOrNull(stmt.total_liabilities_mn ?? stmt.totalLiabilitiesMn);
      const currentAssetsMn = numOrNull(stmt.current_assets_mn ?? stmt.currentAssetsMn);
      const currentLiabilitiesMn = numOrNull(stmt.current_liabilities_mn ?? stmt.currentLiabilitiesMn);
      const capexMn = numOrNull(stmt.capex_mn ?? stmt.capexMn);
      const operatingCashFlowMn = numOrNull(stmt.operating_cash_flow_mn ?? stmt.operatingCashFlowMn);
      const freeCashFlowMn = numOrNull(stmt.free_cash_flow_mn ?? stmt.freeCashFlowMn);
      const debtToEquity = numOrNull(stmt.debt_to_equity ?? stmt.debtToEquity);
      const currentRatio = numOrNull(stmt.current_ratio ?? stmt.currentRatio);

      if (dps !== null && dps < 0) {
        errors.push(`FY${yr} DPS cannot be negative (৳${dps})`);
      }
      if (bonusPct !== null && bonusPct < 0) {
        errors.push(`FY${yr} Bonus % cannot be negative (${bonusPct}%)`);
      }
      if (shortLoan !== null && shortLoan < 0) {
        errors.push(`FY${yr} Short-term loan cannot be negative (${shortLoan} mn)`);
      }
      if (longLoan !== null && longLoan < 0) {
        errors.push(`FY${yr} Long-term loan cannot be negative (${longLoan} mn)`);
      }
      if (revenueMn !== null && revenueMn < 0) {
        errors.push(`FY${yr} Revenue cannot be negative (${revenueMn} mn)`);
      }
      if (revenueMn !== null && grossProfitMn !== null && grossProfitMn > revenueMn) {
        errors.push(`FY${yr} Gross profit (${grossProfitMn} mn) cannot exceed revenue (${revenueMn} mn)`);
      }
      if (totalAssetsMn !== null && totalAssetsMn < 0) {
        errors.push(`FY${yr} Total assets cannot be negative (${totalAssetsMn} mn)`);
      }
      if (totalLiabilitiesMn !== null && totalLiabilitiesMn < 0) {
        errors.push(`FY${yr} Total liabilities cannot be negative (${totalLiabilitiesMn} mn)`);
      }
      if (operatingCashFlowMn !== null && capexMn !== null && freeCashFlowMn !== null) {
        const expectedFcf = parseFloat((operatingCashFlowMn - capexMn).toFixed(2));
        if (Math.abs(freeCashFlowMn - expectedFcf) > 0.05) {
          errors.push(`FY${yr} Free cash flow mismatch: ${freeCashFlowMn} vs expected ${expectedFcf} mn`);
        }
      }

      cleanStatements.push({
        symbol: symbol.toUpperCase().trim(),
        year: yr,
        fiscal_year: yr,
        period: stmt.period || 'Annual',
        eps,
        navps,
        dps,
        bonus_pct: bonusPct,
        roe,
        pe_ratio: numOrNull(stmt.pe_ratio),
        pb_ratio: numOrNull(stmt.pb_ratio),
        dividend_yield: numOrNull(stmt.dividend_yield),
        paid_up_capital_mn: numOrNull(stmt.paid_up_capital_mn),
        net_income_mn: numOrNull(stmt.net_income_mn),
        reserve_surplus_mn: numOrNull(stmt.reserve_surplus_mn),
        oci_mn: numOrNull(stmt.oci_mn),
        short_term_loan_mn: shortLoan,
        long_term_loan_mn: longLoan,
        revenue_mn: revenueMn,
        gross_profit_mn: grossProfitMn,
        operating_profit_mn: operatingProfitMn,
        total_assets_mn: totalAssetsMn,
        total_liabilities_mn: totalLiabilitiesMn,
        current_assets_mn: currentAssetsMn,
        current_liabilities_mn: currentLiabilitiesMn,
        capex_mn: capexMn,
        operating_cash_flow_mn: operatingCashFlowMn,
        free_cash_flow_mn: freeCashFlowMn,
        debt_to_equity: debtToEquity,
        current_ratio: currentRatio,
        source: stmt.source || 'DSE_OFFICIAL'
      });
    }

    const sorted = cleanStatements.sort((a, b) => b.year - a.year);

    return {
      passed: errors.length === 0,
      symbol,
      yearsCount: sorted.length,
      errors,
      warnings,
      cleaned: sorted
    };
  }

  /**
   * Audit DSEX Macro Benchmark Timeline
   */
  static auditDSEXHistory(records = []) {
    const errors = [];
    const warnings = [];
    const cleanRecords = [];
    const seenDates = new Set();

    for (const r of records) {
      const dStr = String(r.trade_date || r.date || '').slice(0, 10);
      const rawDsex = r.index_value ?? r.dsexIndex ?? r.dsex_index;

      if (!dStr || seenDates.has(dStr)) continue;
      seenDates.add(dStr);

      if (rawDsex == null) {
        warnings.push(`No DSEX value present for ${dStr} -- record skipped, not audited as an error`);
        continue;
      }
      const dsex = numOrNull(rawDsex);

      if (dsex === null || dsex < 500 || dsex > 20000) {
        errors.push(`DSEX benchmark out of realistic range on ${dStr}: ${rawDsex}`);
        continue;
      }

      // An index value of 0 is as impossible as a stock price of 0 -- null means
      // this session's open/high/low genuinely wasn't disclosed by the source.
      cleanRecords.push({
        trade_date: dStr,
        date: dStr,
        index_value: dsex,
        dsexIndex: dsex,
        index_open: numOrNull(r.index_open),
        index_high: numOrNull(r.index_high),
        index_low: numOrNull(r.index_low),
        source: r.source || 'DSEX'
      });
    }

    return {
      passed: errors.length === 0,
      totalPoints: cleanRecords.length,
      errors,
      warnings,
      cleaned: cleanRecords.sort((a, b) => new Date(a.trade_date || a.date) - new Date(b.trade_date || b.date))
    };
  }

  /**
   * Audit one market-breadth / DSEX-closing snapshot (Job 1's daily close, Job 4's
   * 30-min intraday snapshot). Previously neither write path in server/index.js
   * ran any validation before persisting -- this is the gate for that.
   */
  static auditMarketBreadthSnapshot(snapshot = {}) {
    const errors = [];
    const warnings = [];

    const dsexIndex = numOrNull(snapshot.dsexIndex ?? snapshot.dsex_index);
    if (dsexIndex !== null && (dsexIndex < 500 || dsexIndex > 20000)) {
      errors.push(`DSEX benchmark out of realistic range: ${dsexIndex}`);
    }

    const advancing = numOrNull(snapshot.advancing);
    const declining = numOrNull(snapshot.declining);
    const unchanged = numOrNull(snapshot.unchanged);
    // The exact hardcoded output of a since-deleted fabrication generator --
    // a permanent regression guard, see ARCHITECTURE.md Known Incidents.
    if (advancing === 180 && declining === 140 && unchanged === 60) {
      errors.push('Breadth matches a known fabrication signature (advancing=180, declining=140, unchanged=60)');
    }

    const cleaned = {
      dsexIndex,
      advancing,
      declining,
      unchanged,
      totalTrades: numOrNull(snapshot.totalTrades ?? snapshot.total_trades),
      totalVolume: numOrNull(snapshot.totalVolume ?? snapshot.total_volume),
      totalValueMn: numOrNull(snapshot.totalValueMn ?? snapshot.turnoverMn ?? snapshot.total_value_mn),
    };

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      cleaned
    };
  }

  /**
   * Audit one DS30 index-level snapshot (the daily index value + day-over-day
   * change server/index.js's DS30 index scraper produces). Separate from
   * auditMarketBreadthSnapshot (that one is DSEX + breadth counts) because DS30
   * is a different index with its own realistic range -- reusing DSEX's
   * 500-20000 band would let a badly-parsed DS30 value (e.g. accidentally
   * picking up the DSEX or Shariah series instead) through uncaught.
   */
  static auditDS30Snapshot(snapshot = {}) {
    const errors = [];
    const warnings = [];

    const ds30Index = numOrNull(snapshot.ds30Index ?? snapshot.ds30_index);
    if (ds30Index !== null && (ds30Index < DS30_INDEX_MIN || ds30Index > DS30_INDEX_MAX)) {
      errors.push(`DS30 index out of realistic range: ${ds30Index}`);
    }

    const prevClose = numOrNull(snapshot.prevClose ?? snapshot.prev_close);
    if (prevClose !== null && (prevClose < DS30_INDEX_MIN || prevClose > DS30_INDEX_MAX)) {
      errors.push(`DS30 previous close out of realistic range: ${prevClose}`);
    }

    // changePercent is always derived from ds30Index/prevClose below, never
    // trusted as an independently-supplied field -- a scraper bug in one place
    // can't silently disagree with the two real numbers it was computed from.
    const changePercent = (ds30Index !== null && prevClose !== null && prevClose > 0)
      ? Number((((ds30Index - prevClose) / prevClose) * 100).toFixed(2))
      : null;
    if (changePercent !== null && Math.abs(changePercent) > 15) {
      warnings.push(`DS30 day-over-day change looks unusually large: ${changePercent}% (not blocked, flagged for review)`);
    }

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      cleaned: { ds30Index, prevClose, changePercent }
    };
  }

  /**
   * Audit one company-list record (symbol, name, sector, category, face value,
   * total shares). Different in kind from the financial-value auditors above --
   * this is identity/classification metadata, not a time series -- but subject to
   * the same rule: a genuinely unknown face_value/total_shares must be null, never
   * a silently-assumed default (company_list_scraper.js used to default face value
   * to 10 -- the common case, but not universal -- for any company whose real
   * value wasn't found on the page).
   */
  static auditCompanyListRecord(record = {}) {
    const errors = [];
    const warnings = [];

    const symbol = String(record.symbol || '').toUpperCase().trim();
    if (!symbol) {
      errors.push('Missing or empty symbol');
      return { passed: false, errors, warnings, cleaned: null };
    }

    const faceValue = numOrNull(record.face_value);
    if (faceValue !== null && faceValue <= 0) {
      errors.push(`${symbol}: face_value must be positive, got ${faceValue}`);
    }
    const totalShares = numOrNull(record.total_shares);
    if (totalShares !== null && totalShares <= 0) {
      errors.push(`${symbol}: total_shares must be positive, got ${totalShares}`);
    }

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      cleaned: {
        symbol,
        name: record.name || null,
        sector: record.sector || null,
        category: record.category || null,
        face_value: (faceValue !== null && faceValue > 0) ? faceValue : null,
        total_shares: (totalShares !== null && totalShares > 0) ? totalShares : null,
      }
    };
  }

  // Shareholding pattern (2026-08-24) -- each category must be a plausible
  // 0-100 percentage, and the five must sum to ~100% (DSE rounds each
  // category to 2dp, so a few hundredths of drift is normal rounding, not a
  // parsing bug -- the tolerance below is deliberately generous at 1.0 to
  // absorb that without masking a real mis-parse, e.g. reading the wrong
  // <td> and getting a materially wrong sum).
  static auditShareholdingRecord(symbol, snapshot = {}) {
    const errors = [];
    const warnings = [];
    const fields = ['sponsorPct', 'govtPct', 'institutePct', 'foreignPct', 'publicPct'];

    for (const f of fields) {
      const v = numOrNull(snapshot[f]);
      if (v === null) {
        errors.push(`${symbol}: shareholding.${f} is missing/unparseable`);
      } else if (v < 0 || v > 100) {
        errors.push(`${symbol}: shareholding.${f} = ${v} is outside the plausible 0-100% range`);
      }
    }
    if (errors.length === 0) {
      const sum = fields.reduce((acc, f) => acc + Number(snapshot[f]), 0);
      if (Math.abs(sum - 100) > SHAREHOLDING_SUM_TOLERANCE_PCT) {
        errors.push(`${symbol}: shareholding categories sum to ${sum.toFixed(2)}%, expected ~100%`);
      }
    }

    return { passed: errors.length === 0, errors, warnings };
  }

  /**
   * Audit one block-market (institutional) transaction row before it reaches
   * block_market_history. Previously this table had no DataAuditor gate at
   * all -- scrape_current_block_market.js wrote parsed rows straight to the
   * DB, violating the "every scraper audits its output before it reaches a
   * DB write" rule (ARCHITECTURE.md). Mirrors auditPriceHistory's shape
   * (per-symbol date validity, duplicate-date filtering) plus the
   * min_price<=max_price identity a block trade must satisfy.
   */
  static auditBlockMarketRecord(symbol, records = []) {
    const errors = [];
    const warnings = [];
    const cleanRecords = [];
    const seenDates = new Set();

    if (!records || !Array.isArray(records) || records.length === 0) {
      return { passed: false, symbol, errors: ['Block market records array is empty'], warnings, cleaned: [] };
    }

    for (const r of records) {
      const dStr = String(r.date || r.trade_date || '').slice(0, 10);
      if (!dStr || !/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
        errors.push(`Invalid date format: ${dStr}`);
        continue;
      }
      if (seenDates.has(dStr)) {
        warnings.push(`Duplicate block-market record for ${dStr} filtered out`);
        continue;
      }
      seenDates.add(dStr);

      const quantity = positiveNumOrNull(r.quantity);
      if (quantity === null) {
        errors.push(`${dStr}: quantity must be a positive number, got ${r.quantity}`);
        continue;
      }

      const valueMn = numOrNull(r.value_mn);
      if (valueMn !== null && valueMn <= 0) {
        errors.push(`${dStr}: value_mn must be positive if present, got ${valueMn}`);
        continue;
      }

      const minPrice = numOrNull(r.min_price);
      const maxPrice = numOrNull(r.max_price);
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        errors.push(`${dStr}: min_price (${minPrice}) cannot exceed max_price (${maxPrice})`);
        continue;
      }

      cleanRecords.push({
        symbol: symbol.toUpperCase().trim(),
        date: dStr,
        trades: numOrNull(r.trades),
        quantity,
        value_mn: valueMn,
        min_price: minPrice,
        max_price: maxPrice,
        source: r.source || 'LANKABD'
      });
    }

    return {
      passed: errors.length === 0,
      symbol,
      totalInput: records.length,
      validRecords: cleanRecords.length,
      errors,
      warnings,
      cleaned: cleanRecords
    };
  }
}
