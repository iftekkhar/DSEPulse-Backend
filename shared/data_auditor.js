/**
 * Institutional Data Auditor & Sanity Validator -- shared by both the Pipeline
 * Staging DB gate (pipeline/src/audit/audit_runner.js) and every direct-to-main-DB
 * write path in server/index.js (Job 1/3/4, live sync). One validator, one set of
 * thresholds, used before every DB write in this project -- not a pipeline-only
 * concept that server/ writes bypass.
 */
import { numOrNull, positiveNumOrNull, deriveOrNull, roundOrNull } from './safe_number.js';

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

      cleanStatements.push({
        symbol: symbol.toUpperCase().trim(),
        year: yr,
        fiscal_year: yr,
        period: stmt.period || 'Annual',
        eps,
        navps,
        dps: numOrNull(stmt.dps),
        bonus_pct: numOrNull(stmt.bonus_pct),
        roe,
        pe_ratio: numOrNull(stmt.pe_ratio),
        pb_ratio: numOrNull(stmt.pb_ratio),
        dividend_yield: numOrNull(stmt.dividend_yield),
        paid_up_capital_mn: numOrNull(stmt.paid_up_capital_mn),
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
    // The exact hardcoded output of the deleted pipeline/src/builders/dsex_builder.js
    // fabrication generator -- a permanent regression guard, see ARCHITECTURE.md.
    if (advancing === 180 && declining === 140 && unchanged === 60) {
      errors.push('Breadth matches the known dsex_builder.js fabrication signature (advancing=180, declining=140, unchanged=60)');
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
      if (Math.abs(sum - 100) > 1.0) {
        errors.push(`${symbol}: shareholding categories sum to ${sum.toFixed(2)}%, expected ~100%`);
      }
    }

    return { passed: errors.length === 0, errors, warnings };
  }
}
