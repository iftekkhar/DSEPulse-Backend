/**
 * Institutional Data Auditor & Sanity Validator for DSEPulse Data Pipeline
 */

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
      const close = Number(r.close ?? r.ltp ?? 0);

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
        const prevClose = Number(sorted[i - 1].close ?? sorted[i - 1].ltp ?? close);
        if (prevClose > 0) {
          const ratio = close / prevClose;
          if (ratio > 3.0 || ratio < 0.25) {
            warnings.push(`Extreme price swing on ${dStr}: ৳${prevClose} -> ৳${close} (${((ratio - 1) * 100).toFixed(1)}%)`);
          }
        }
      }

      // Check 5: Valuation multiples sanity
      let pe = r.pe !== null && r.pe !== undefined ? Number(r.pe) : null;
      if (pe !== null && (pe < 0 || pe > 300)) {
        warnings.push(`Unusual P/E on ${dStr}: ${pe}x`);
      }

      // No 0/close fallbacks: this project's whole sourcing policy is that a
      // genuinely unknown value stays null, never a fabricated "confirmed zero" or
      // (for ycp) a copy of today's close that would silently zero out change%.
      const hasYcp = r.ycp !== null && r.ycp !== undefined;
      const ycpVal = hasYcp ? Number(r.ycp) : null;
      cleanRecords.push({
        symbol: symbol.toUpperCase().trim(),
        date: dStr,
        trade_date: dStr,
        close,
        ltp: close,
        ycp: ycpVal,
        change: r.change !== null && r.change !== undefined ? Number(r.change) : (hasYcp && ycpVal > 0 ? Number((close - ycpVal).toFixed(2)) : null),
        changePercent: r.changePercent !== null && r.changePercent !== undefined ? Number(r.changePercent) : (hasYcp && ycpVal > 0 ? Number((((close - ycpVal) / ycpVal) * 100).toFixed(2)) : null),
        volume: r.volume !== null && r.volume !== undefined ? Number(r.volume) : null,
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

      const eps = stmt.eps !== null && stmt.eps !== undefined ? Number(stmt.eps) : null;
      const navps = stmt.navps !== null && stmt.navps !== undefined ? Number(stmt.navps) : null;
      // null, not a fabricated 0 -- P/E, P/B, and paid-up capital of literally 0 are
      // impossible for a real listed company, and an unstated ROE/dividend/bonus is
      // "not disclosed", not "confirmed zero". ROE is still derived from real
      // eps/navps when both are present -- that's exact arithmetic, not a guess.
      const roe = stmt.roe !== null && stmt.roe !== undefined
        ? Number(stmt.roe)
        : (eps !== null && navps !== null && navps > 0 ? Number(((eps / navps) * 100).toFixed(2)) : null);

      if (eps !== null && (eps < -200 || eps > 1000)) {
        warnings.push(`Outlier EPS in FY${yr}: ৳${eps}`);
      }

      if (navps !== null && navps <= 0) {
        warnings.push(`FY${yr} NAVPS is negative or zero (৳${navps})`);
      }

      cleanStatements.push({
        symbol: symbol.toUpperCase().trim(),
        year: yr,
        fiscal_year: yr,
        period: stmt.period || 'Annual',
        eps,
        navps,
        dps: stmt.dps !== null && stmt.dps !== undefined ? Number(stmt.dps) : null,
        bonus_pct: stmt.bonus_pct !== null && stmt.bonus_pct !== undefined ? Number(stmt.bonus_pct) : null,
        roe: roe !== null ? Number(roe.toFixed(2)) : null,
        pe_ratio: stmt.pe_ratio !== null && stmt.pe_ratio !== undefined ? Number(stmt.pe_ratio) : null,
        pb_ratio: stmt.pb_ratio !== null && stmt.pb_ratio !== undefined ? Number(stmt.pb_ratio) : null,
        dividend_yield: stmt.dividend_yield !== null && stmt.dividend_yield !== undefined ? Number(stmt.dividend_yield) : null,
        paid_up_capital_mn: stmt.paid_up_capital_mn !== null && stmt.paid_up_capital_mn !== undefined ? Number(stmt.paid_up_capital_mn) : null,
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
      const dsex = Number(rawDsex);

      if (isNaN(dsex) || dsex < 500 || dsex > 20000) {
        errors.push(`DSEX benchmark out of realistic range on ${dStr}: ${dsex}`);
        continue;
      }

      // An index value of 0 is as impossible as a stock price of 0 -- null means
      // this session's open/high/low genuinely wasn't disclosed by the source.
      cleanRecords.push({
        trade_date: dStr,
        date: dStr,
        index_value: dsex,
        dsexIndex: dsex,
        index_open: r.index_open !== null && r.index_open !== undefined ? Number(r.index_open) : null,
        index_high: r.index_high !== null && r.index_high !== undefined ? Number(r.index_high) : null,
        index_low: r.index_low !== null && r.index_low !== undefined ? Number(r.index_low) : null,
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
}
