/**
 * Block Market Transactions Institutional Auditor
 *
 * Internal consistency check over `block_market_history` -- no live fetch,
 * despite the registry key name `auditor.external_crosscheck_block_market`
 * (corrected 2026-09-01; the key/description previously implied a live
 * lankabd.com re-fetch this file has never actually performed):
 * - Verifies min_price <= max_price
 * - Verifies quantity > 0 and value_mn > 0
 * - Saves audit status into `audit_reports` table
 */

import { fileURLToPath } from 'url';
import { dbAll, initDB, saveMainDBAuditReport } from '../db.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';

export async function runBlockMarketCrossCheck() {
  if (!isScraperEnabled('auditor.external_crosscheck_block_market')) {
    console.log(scraperBlockedMessage('auditor.external_crosscheck_block_market'));
    return { passed: false, blocked: true };
  }

  await initDB();
  console.log('========================================================================');
  console.log('  🔍 DSE PULSE BLOCK MARKET TRANSACTIONS AUDITOR');
  console.log('========================================================================\n');

  const rows = await dbAll(`SELECT * FROM block_market_history ORDER BY date DESC, symbol ASC`);
  console.log(`Auditing ${rows.length} block market transaction records in database...`);

  let invalidPrices = 0;
  let invalidQuantities = 0;
  let invalidValues = 0;
  const errors = [];
  const warnings = [];

  for (const r of rows) {
    if (r.min_price != null && r.max_price != null && r.min_price > r.max_price) {
      invalidPrices++;
      errors.push(`${r.symbol} on ${r.date}: min_price (${r.min_price}) > max_price (${r.max_price})`);
    }
    if (r.quantity == null || r.quantity <= 0) {
      invalidQuantities++;
      errors.push(`${r.symbol} on ${r.date}: invalid quantity (${r.quantity})`);
    }
    if (r.value_mn == null || r.value_mn <= 0) {
      invalidValues++;
      warnings.push(`${r.symbol} on ${r.date}: zero/missing value_mn`);
    }
  }

  const passed = errors.length === 0;
  const status = passed ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  console.log(`\n======================================================`);
  console.log(`BLOCK MARKET AUDIT SUMMARY: ${passed ? '\x1b[32mCERTIFIED_PASSED\x1b[0m' : '\x1b[31mAUDIT_FAILED\x1b[0m'}`);
  console.log(`Total Records Audited : ${rows.length}`);
  console.log(`Blocking Errors       : ${errors.length}`);
  console.log(`Warnings / Notes      : ${warnings.length}`);
  console.log(`======================================================\n`);

  try {
    await saveMainDBAuditReport({
      targetEntity: 'BLOCK_MARKET',
      recordsAudited: rows.length,
      errorsCount: errors.length,
      warningsCount: warnings.length,
      status,
      reportJson: {
        totalRecords: rows.length,
        errors,
        warnings
      }
    });
  } catch (err) {
    console.error('[AUDITOR] Failed to save block market audit report:', err.message);
  }

  return { passed, status, recordsAudited: rows.length, errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runBlockMarketCrossCheck()
    .then(res => {
      if (!res.passed) process.exit(1);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
