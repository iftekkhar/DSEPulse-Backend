/**
 * PDF Financial Statement Institutional Auditor
 *
 * Validates integrity of audited financial statements in `fundamentals_history`:
 * - Verifies non-negative revenue and assets
 * - Verifies gross profit <= revenue
 * - Verifies accounting balance consistency
 * - Verifies source provenance (Tier 1)
 * - Logs audit report to `audit_reports` table
 */

import { fileURLToPath } from 'url';
import { dbAll, initDB, saveMainDBAuditReport } from '../db.js';
import { validateAccountingIdentities } from '../parsers/pdf_financial_parser.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';

export async function runPdfStatementsCrossCheck() {
  if (!isScraperEnabled('auditor.external_crosscheck_pdf_statements')) {
    console.log(scraperBlockedMessage('auditor.external_crosscheck_pdf_statements'));
    return { passed: false, blocked: true };
  }

  await initDB();
  console.log('========================================================================');
  console.log('  🔍 DSE PULSE AUDITED PDF FINANCIAL STATEMENTS AUDITOR');
  console.log('========================================================================\n');

  const rows = await dbAll(`
    SELECT * FROM fundamentals_history
    WHERE revenue_mn IS NOT NULL
       OR total_assets_mn IS NOT NULL
       OR gross_profit_mn IS NOT NULL
       OR capex_mn IS NOT NULL
    ORDER BY symbol ASC, fiscal_year DESC
  `);

  console.log(`Auditing ${rows.length} financial statement records with PDF line items...`);

  const errors = [];
  const warnings = [];

  for (const r of rows) {
    const val = validateAccountingIdentities(r);
    if (!val.passed) {
      errors.push(...val.errors.map(e => `${r.symbol} (FY${r.fiscal_year}): ${e}`));
    }
    if (val.warnings.length > 0) {
      warnings.push(...val.warnings.map(w => `${r.symbol} (FY${r.fiscal_year}): ${w}`));
    }

    if (r.operating_cash_flow_mn != null && r.capex_mn != null && r.free_cash_flow_mn != null) {
      const expectedFcf = parseFloat((r.operating_cash_flow_mn - r.capex_mn).toFixed(2));
      if (Math.abs(r.free_cash_flow_mn - expectedFcf) > 0.05) {
        errors.push(`${r.symbol} (FY${r.fiscal_year}): Free Cash Flow mismatch (${r.free_cash_flow_mn} vs expected ${expectedFcf})`);
      }
    }
  }

  const passed = errors.length === 0;
  const status = passed ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  console.log(`\n======================================================`);
  console.log(`PDF STATEMENTS AUDIT SUMMARY: ${passed ? '\x1b[32mCERTIFIED_PASSED\x1b[0m' : '\x1b[31mAUDIT_FAILED\x1b[0m'}`);
  console.log(`Total Statements Audited : ${rows.length}`);
  console.log(`Blocking Errors          : ${errors.length}`);
  console.log(`Warnings / Notes         : ${warnings.length}`);
  console.log(`======================================================\n`);

  try {
    await saveMainDBAuditReport({
      targetEntity: 'PDF_FINANCIAL_STATEMENTS',
      recordsAudited: rows.length,
      errorsCount: errors.length,
      warningsCount: warnings.length,
      status,
      reportJson: { totalRecords: rows.length, errors, warnings }
    });
  } catch (err) {
    console.error('[AUDITOR] Failed to save PDF statements audit report:', err.message);
  }

  return { passed, status, recordsAudited: rows.length, errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPdfStatementsCrossCheck()
    .then(res => {
      if (!res.passed) process.exit(1);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
