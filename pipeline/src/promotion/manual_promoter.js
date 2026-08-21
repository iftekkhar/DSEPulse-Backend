import { dbAll } from '../db/staging_db.js';
import { runFullStagingAudit } from '../audit/audit_runner.js';
import {
  publishStockHistory,
  publishCompanyFundamentals,
  publishDSEXHistory
} from '../sync/publisher.js';

/**
 * MANUAL USER-CONTROLLED PROMOTION ENGINE
 * 
 * Strict Rule: This script will NEVER execute automatically.
 * It requires explicit user invocation with the `--confirm` flag.
 */
export async function promoteStagingToMainDB(explicitConfirm = false) {
  console.log('\n======================================================');
  console.log('   MANUAL PROMOTION TO MAIN BACKEND DATABASE');
  console.log('======================================================\n');

  if (!explicitConfirm) {
    console.error('  \x1b[31m✖ PROMOTION BLOCKED\x1b[0m: Explicit user confirmation required.');
    console.log('  To promote verified staging records to the Main Database, run:');
    console.log('    \x1b[33mnpm run promote:main --confirm\x1b[0m\n');
    return { success: false, reason: 'Confirmation flag missing' };
  }

  // 1. Mandatory Audit Gate Check
  console.log('Step 1: Running mandatory institutional audit gate...');
  const auditResult = await runFullStagingAudit();

  if (!auditResult.passed || auditResult.totalErrors > 0) {
    console.error('  \x1b[31m✖ PROMOTION HALTED\x1b[0m: Staging data has audit errors.');
    console.error(`  Total Blocking Errors: ${auditResult.totalErrors}`);
    console.error('  Resolve audit errors before promoting to Main DB.\n');
    return { success: false, reason: 'Audit failed', errors: auditResult.totalErrors };
  }

  console.log('  \x1b[32m✔ AUDIT GATE PASSED\x1b[0m (0 blocking errors). Proceeding with user-authorized promotion...\n');

  // 2. Promote Staged DSEX Records
  const dsexRows = await dbAll('SELECT * FROM stg_dsex_market_history ORDER BY date ASC');
  if (dsexRows.length > 0) {
    console.log(`Promoting ${dsexRows.length} DSEX historical sessions to Main DB...`);
    await publishDSEXHistory(dsexRows);
    console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted ${dsexRows.length} DSEX sessions.`);
  }

  // 3. Promote Staged Price History
  const priceRows = await dbAll('SELECT * FROM stg_price_history ORDER BY symbol, date ASC');
  const priceSymbolsMap = new Map();
  for (const r of priceRows) {
    if (!priceSymbolsMap.has(r.symbol)) priceSymbolsMap.set(r.symbol, []);
    priceSymbolsMap.get(r.symbol).push(r);
  }

  for (const [sym, records] of priceSymbolsMap.entries()) {
    console.log(`Promoting ${records.length} price records for ${sym}...`);
    await publishStockHistory(sym, records);
  }
  console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted price histories across ${priceSymbolsMap.size} symbols.`);

  // 4. Promote Staged 20-Year Financial Statements
  const fundRows = await dbAll('SELECT * FROM stg_fundamentals_history ORDER BY symbol, fiscal_year DESC');
  const fundSymbolsMap = new Map();
  for (const r of fundRows) {
    if (!fundSymbolsMap.has(r.symbol)) fundSymbolsMap.set(r.symbol, []);
    fundSymbolsMap.get(r.symbol).push(r);
  }

  for (const [sym, stmts] of fundSymbolsMap.entries()) {
    console.log(`Promoting ${stmts.length} audited statements for ${sym}...`);
    await publishCompanyFundamentals(sym, { symbol: sym }, stmts);
  }
  console.log(`  \x1b[32m✔ SUCCESS\x1b[0m Promoted audited statements across ${fundSymbolsMap.size} companies.`);

  console.log('\n======================================================');
  console.log('   PROMOTION COMPLETED SUCCESSFULLY');
  console.log('   Main Database is now synchronized with audited data.');
  console.log('======================================================\n');

  return { success: true, priceSymbols: priceSymbolsMap.size, fundSymbols: fundSymbolsMap.size };
}
