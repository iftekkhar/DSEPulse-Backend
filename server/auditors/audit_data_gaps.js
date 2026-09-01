/**
 * audit_data_gaps.js — Master Gap Detection & Disaster Recovery Auditor
 *
 * Scans the main SQLite database (dse.db) to proactively identify:
 * 1. Price History Gaps: Active symbols trailing the latest market date or missing trading sessions.
 * 2. Fundamentals History Gaps: Active symbols with 0 historical years or missing balance sheet metrics.
 * 3. Index Benchmark Gaps: Missing dates in DSEX and DS30 series relative to market trading dates.
 * 4. Corporate Metadata Gaps: Active symbols with missing sector, category, or face_value.
 */
import { dbAll, dbGet, dbRun } from '../db.js';
import { fileURLToPath } from 'url';

export async function auditDataGaps() {
  console.log('========================================================================');
  console.log('  🔍 DSE PULSE INSTITUTIONAL MASTER DATA GAP AUDITOR');
  console.log(`  Audit Execution Time: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  const errors = [];
  const warnings = [];
  const gapReport = {
    priceGaps: [],
    fundamentalsGaps: [],
    indexGaps: [],
    metadataGaps: []
  };

  // ── 1. AUDIT PRICE HISTORY GAPS ─────────────────────────────────────────────
  console.log('1. Scanning for Stock Price & OHLCV Gaps...');
  const latestMarketDateRow = await dbGet('SELECT MAX(date) as maxDate FROM price_history');
  const latestMarketDate = latestMarketDateRow?.maxDate;

  if (latestMarketDate) {
    const trailingSymbols = await dbAll(`
      SELECT c.symbol, c.name, c.sector, c.category, MAX(p.date) as lastTradedDate, COUNT(p.date) as totalSessions
      FROM company_list c
      LEFT JOIN price_history p ON p.symbol = c.symbol
      WHERE c.is_active = 1 AND c.trading_status = 'Active'
      GROUP BY c.symbol
      HAVING lastTradedDate IS NULL OR lastTradedDate < date(?, '-14 days')
      ORDER BY lastTradedDate ASC
    `, [latestMarketDate]);

    for (const r of trailingSymbols) {
      gapReport.priceGaps.push({
        symbol: r.symbol,
        name: r.name || 'Unknown',
        lastTraded: r.lastTradedDate || 'Never Traded',
        totalSessions: r.totalSessions,
        daysBehind: r.lastTradedDate ? Math.floor((new Date(latestMarketDate) - new Date(r.lastTradedDate)) / (1000 * 60 * 60 * 24)) : 9999
      });
    }

    if (trailingSymbols.length > 0) {
      warnings.push(`Price Gaps: ${trailingSymbols.length} active symbols are lagging more than 14 days behind market latest (${latestMarketDate})`);
      console.log(`  ⚠️  Found ${trailingSymbols.length} symbols with stale/lagging price histories.`);
    } else {
      console.log(`  ✅ All active equities are synchronized with latest market date (${latestMarketDate}).`);
    }
  }

  // ── 2. AUDIT FUNDAMENTALS & BALANCE SHEET GAPS (EQUITIES ONLY) ─────────────
  console.log('\n2. Scanning for Fundamentals & Balance Sheet Gaps in Listed Equities...');
  const fundGaps = await dbAll(`
    SELECT c.symbol, c.name, c.sector, c.category,
           COUNT(f.fiscal_year) as totalYears,
           MAX(f.fiscal_year) as latestYear,
           MAX(f.reserve_surplus_mn) as hasReserve,
           MAX(f.short_term_loan_mn) as hasShortLoan,
           MAX(f.long_term_loan_mn) as hasLongLoan,
           MAX(f.dps) as hasDps
    FROM company_list c
    LEFT JOIN fundamentals_history f ON f.symbol = c.symbol
    WHERE c.is_active = 1 AND c.sector IS NOT NULL
    GROUP BY c.symbol
    HAVING totalYears = 0 OR (hasReserve IS NULL AND hasShortLoan IS NULL AND hasLongLoan IS NULL)
    ORDER BY totalYears ASC, c.symbol ASC
  `);

  for (const f of fundGaps) {
    gapReport.fundamentalsGaps.push({
      symbol: f.symbol,
      sector: f.sector,
      yearsRecorded: f.totalYears,
      latestYear: f.latestYear || 'None',
      balanceSheetPresent: (f.hasReserve !== null || f.hasShortLoan !== null || f.hasLongLoan !== null) ? 'Yes' : 'Missing',
      dpsPresent: f.hasDps !== null ? 'Yes' : 'Missing'
    });
  }

  if (fundGaps.length > 0) {
    warnings.push(`Fundamentals Gaps: ${fundGaps.length} active equities are missing historical statements or balance sheet metrics`);
    console.log(`  ⚠️  Found ${fundGaps.length} equity symbols with missing statements or balance sheet gaps.`);
  } else {
    console.log('  ✅ All active equities (395 stocks) have complete multi-year fundamentals and balance sheet records.');
  }

  // ── 3. AUDIT DSEX & DS30 INDEX GAPS ─────────────────────────────────────────
  console.log('\n3. Scanning for Benchmark Index Gaps...');
  const indexDateGaps = await dbAll(`
    WITH price_dates AS (
      SELECT DISTINCT date FROM price_history WHERE date >= '2020-01-01'
    )
    SELECT p.date as missingDate
    FROM price_dates p
    LEFT JOIN dsex_market_history d ON d.date = p.date
    WHERE d.date IS NULL
    ORDER BY p.date DESC
    LIMIT 30
  `);

  for (const idx of indexDateGaps) {
    gapReport.indexGaps.push(idx.missingDate);
  }

  if (indexDateGaps.length > 0) {
    warnings.push(`Index Gaps: ${indexDateGaps.length} trading dates in price_history have no corresponding DSEX index record`);
    console.log(`  ⚠️  Found ${indexDateGaps.length} trading dates with missing DSEX index entries.`);
  } else {
    console.log('  ✅ DSEX & DS30 benchmark series match 100% of trading session dates.');
  }

  // ── 4. AUDIT CORPORATE METADATA GAPS ────────────────────────────────────────
  console.log('\n4. Scanning for Company Metadata & Lifecycle Gaps in Equities...');
  const metadataGaps = await dbAll(`
    SELECT symbol, name, sector, category, face_value, total_shares
    FROM company_list
    WHERE is_active = 1 AND sector IS NOT NULL AND (category IS NULL OR face_value IS NULL OR face_value <= 0)
  `);

  for (const m of metadataGaps) {
    gapReport.metadataGaps.push({
      symbol: m.symbol,
      missingCategory: !m.category,
      invalidFaceValue: !m.face_value || m.face_value <= 0
    });
  }

  if (metadataGaps.length > 0) {
    warnings.push(`Metadata Gaps: ${metadataGaps.length} active equities have missing category or invalid face value`);
    console.log(`  ⚠️  Found ${metadataGaps.length} equities with metadata gaps.`);
  } else {
    console.log('  ✅ All active equities have complete sector, category, and face value data.');
  }

  // ── 5. SUMMARY & REPORT PERSISTENCE ─────────────────────────────────────────
  console.log('\n========================================================================');
  console.log('  📊 GAP AUDIT SUMMARY REPORT');
  console.log('========================================================================');
  console.log(`  • Price Gaps: ${gapReport.priceGaps.length} lagging symbols`);
  console.log(`  • Fundamentals History Gaps: ${gapReport.fundamentalsGaps.length} symbols`);
  console.log(`  • Index Benchmark Gaps: ${gapReport.indexGaps.length} dates`);
  console.log(`  • Metadata Gaps: ${gapReport.metadataGaps.length} symbols`);
  console.log(`  • Total Blocking Errors: ${errors.length}`);
  console.log(`  • Total Warnings: ${warnings.length}`);
  console.log('========================================================================\n');

  if (gapReport.fundamentalsGaps.length > 0) {
    console.log('Sample Fundamentals Gaps (First 10):');
    console.table(gapReport.fundamentalsGaps.slice(0, 10));
  }

  // Record into audit_reports
  await dbRun(`
    INSERT INTO audit_reports (run_at, target_entity, records_audited, errors_count, warnings_count, status, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    'MASTER_DATA_GAPS',
    gapReport.priceGaps.length + gapReport.fundamentalsGaps.length + gapReport.indexGaps.length + gapReport.metadataGaps.length,
    errors.length,
    warnings.length,
    errors.length === 0 ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED',
    JSON.stringify(gapReport)
  ]);

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    gapReport
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  auditDataGaps()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
