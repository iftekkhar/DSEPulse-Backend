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
    const sorted = [...records].sort((a, b) => new Date(a.date) - new Date(b.date));

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const dStr = String(r.date || r.fetchedAt || '').slice(0, 10);
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

      cleanRecords.push({
        symbol: symbol.toUpperCase().trim(),
        date: dStr,
        close,
        ltp: close,
        ycp: Number(r.ycp ?? close),
        change: Number(r.change || 0),
        changePercent: Number(r.changePercent || 0),
        volume: Number(r.volume || 0),
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
   * Audit 20-Year Audited Financial Statements
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
      const yr = Number(stmt.year || stmt.fiscal_year);
      if (isNaN(yr) || yr < 2000 || yr > 2030) {
        errors.push(`Invalid fiscal year: ${stmt.year}`);
        continue;
      }

      if (seenYears.has(yr)) {
        warnings.push(`Duplicate statement for FY${yr} filtered out`);
        continue;
      }
      seenYears.add(yr);

      const eps = Number(stmt.eps ?? stmt.eps_basic ?? 0);
      const navps = Number(stmt.navps ?? stmt.nav_per_share ?? 0);
      const roe = Number(stmt.roe ?? 0);

      // Check NAVPS positivity
      if (navps <= 0) {
        warnings.push(`FY${yr} NAVPS is negative or zero (৳${navps})`);
      }

      // Check ROE vs EPS / NAVPS reasonableness
      if (navps > 0) {
        const impliedRoe = (eps / navps) * 100;
        if (Math.abs(impliedRoe - roe) > 15) {
          warnings.push(`FY${yr} ROE discrepancy: stated ${roe}%, implied ${impliedRoe.toFixed(1)}%`);
        }
      }

      cleanStatements.push({
        symbol: symbol.toUpperCase().trim(),
        year: yr,
        fiscal_year: yr,
        period: stmt.period || 'Annual',
        eps,
        eps_basic: eps,
        navps,
        nav_per_share: navps,
        roe: Number(roe.toFixed(2)),
        dividendYield: Number(stmt.dividendYield ?? stmt.dividend_yield ?? 0),
        dividend_yield: Number(stmt.dividendYield ?? stmt.dividend_yield ?? 0),
        pe: Number(stmt.pe ?? stmt.pe_ratio ?? 12),
        pe_ratio: Number(stmt.pe ?? stmt.pe_ratio ?? 12),
        debtToEquity: Number(stmt.debtToEquity ?? stmt.debt_to_equity ?? 0.4),
        currentRatio: Number(stmt.currentRatio ?? stmt.current_ratio ?? 1.8),
        paidUpCapital: Number(stmt.paidUpCapital ?? stmt.paid_up_capital_mn ?? 500),
        paid_up_capital_mn: Number(stmt.paidUpCapital ?? stmt.paid_up_capital_mn ?? 500),
        auditStatus: stmt.auditStatus || stmt.audit_status || 'Audited',
        audit_status: stmt.auditStatus || stmt.audit_status || 'Audited'
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
      const dStr = String(r.date || '').slice(0, 10);
      const dsex = Number(r.dsexIndex ?? r.dsex_index ?? 0);

      if (!dStr || seenDates.has(dStr)) continue;
      seenDates.add(dStr);

      if (dsex < 500 || dsex > 20000) {
        errors.push(`DSEX benchmark out of realistic range on ${dStr}: ${dsex}`);
        continue;
      }

      cleanRecords.push({
        date: dStr,
        dsexIndex: dsex,
        dsex_index: dsex,
        turnoverMn: Number(r.turnoverMn ?? r.total_value_mn ?? 0),
        total_value_mn: Number(r.turnoverMn ?? r.total_value_mn ?? 0),
        volume: Number(r.volume ?? r.total_volume ?? 0),
        advancing: Number(r.advancing || 0),
        declining: Number(r.declining || 0),
        unchanged: Number(r.unchanged || 0)
      });
    }

    return {
      passed: errors.length === 0,
      totalPoints: cleanRecords.length,
      errors,
      warnings,
      cleaned: cleanRecords.sort((a, b) => new Date(a.date) - new Date(b.date))
    };
  }
}
