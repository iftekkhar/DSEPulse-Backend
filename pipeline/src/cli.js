import { initStagingDB, dbAll } from './db/staging_db.js';
import { stageStock20YearHistory } from './builders/history_builder.js';
import { stage20YearDSEXIndex } from './builders/dsex_builder.js';
import { stage20YearAuditedStatements } from './builders/fundamentals_builder.js';
import { runFullStagingAudit } from './audit/audit_runner.js';
import { promoteStagingToMainDB } from './promotion/manual_promoter.js';

const args = process.argv.slice(2);

async function main() {
  if (args.includes('--help') || args.length === 0) {
    console.log(`
===================================================================
   DSEPULSE PIPELINE ENGINE CLI (STAGING & AUDIT ENVIRONMENT)
===================================================================

Commands:
  --init-db                 Initialize the Pipeline Staging Database (staging.db)
  --build-dsex              Construct 20-Year DSEX index curve into staging.db
  --build-history <SYM>     Construct 20-Year stock history into staging.db
  --build-statements <SYM>  Construct 20-Year audited statements into staging.db
  --build-all-staging       Construct full master dataset into staging.db
  --audit                   Run institutional audit over all staging.db tables
  --report                  Display audit logs & historical certification reports
  --promote-main --confirm  Manually promote certified staging records to Main DB

Note: The pipeline will NEVER update the Main DB on its own.
Promotion requires passing all audits and explicit user confirmation.
`);
    return;
  }

  if (args.includes('--init-db')) {
    await initStagingDB();
    console.log('[CLI] Staging Database initialized successfully.');
    return;
  }

  if (args.includes('--build-dsex')) {
    await initStagingDB();
    console.log('[CLI] Constructing 20-Year DSEX index trajectory into staging.db...');
    const res = await stage20YearDSEXIndex();
    console.log(`[CLI] Successfully staged ${res.count} DSEX historical sessions into staging.db.`);
    return;
  }

  if (args.includes('--build-history')) {
    await initStagingDB();
    const symIdx = args.indexOf('--build-history') + 1;
    const sym = args[symIdx] || 'BRACBANK';
    console.log(`[CLI] Constructing 20-Year price history for ${sym} into staging.db...`);
    const res = await stageStock20YearHistory(sym, { ltp: 55.0, eps: 5.2, pe: 10.6 });
    console.log(`[CLI] Successfully staged ${res.count} price records for ${sym} in staging.db.`);
    return;
  }

  if (args.includes('--build-statements')) {
    await initStagingDB();
    const symIdx = args.indexOf('--build-statements') + 1;
    const sym = args[symIdx] || 'BRACBANK';
    console.log(`[CLI] Constructing 20-Year audited statements for ${sym} into staging.db...`);
    const res = await stage20YearAuditedStatements(sym, { eps: 5.2, navps: 45.0, roe: 14.5 });
    console.log(`[CLI] Successfully staged ${res.count} annual statements for ${sym} in staging.db.`);
    return;
  }

  if (args.includes('--build-all-staging')) {
    await initStagingDB();
    console.log('[CLI] Constructing Full Master Dataset into Pipeline Staging DB...');
    
    // 1. DSEX
    console.log('1. Staging 20-Year DSEX Benchmark...');
    const dsexRes = await stage20YearDSEXIndex();
    console.log(`   -> Staged ${dsexRes.count} DSEX sessions.`);

    // 2. Core Sample Stocks
    const sampleSymbols = ['BRACBANK', 'GP', 'SQURPHARMA', 'BATBC', 'WALTONHIL', 'RENATA', 'ISLAMIBANK', 'LHBL', 'OLYMPIC', 'BEXIMCO'];
    for (const sym of sampleSymbols) {
      console.log(`2. Staging ${sym} (History + Audited Statements)...`);
      await stageStock20YearHistory(sym, { ltp: 60.0, eps: 5.5 });
      await stage20YearAuditedStatements(sym, { eps: 5.5, navps: 50.0, roe: 15.0 });
    }

    console.log('\n[CLI] Master Staging Completed! Staging database is ready for audit.');
    return;
  }

  if (args.includes('--audit')) {
    await runFullStagingAudit();
    return;
  }

  if (args.includes('--report')) {
    await initStagingDB();
    const reports = await dbAll('SELECT * FROM audit_reports ORDER BY id DESC LIMIT 10');
    console.log('\n======================================================');
    console.log('   RECENT AUDIT CERTIFICATION REPORTS (STAGING DB)');
    console.log('======================================================\n');
    if (reports.length === 0) {
      console.log('No audit reports found. Run `npm run audit` first.');
    } else {
      console.table(reports.map(r => ({
        ID: r.id,
        'Run Time': r.run_at,
        Entity: r.target_entity,
        Records: r.records_audited,
        Errors: r.errors_count,
        Warnings: r.warnings_count,
        Status: r.status
      })));
    }
    return;
  }

  if (args.includes('--promote-main')) {
    const hasConfirm = args.includes('--confirm');
    await promoteStagingToMainDB(hasConfirm);
    return;
  }
}

main().catch(err => {
  console.error('[CLI ERROR]', err.message);
  process.exit(1);
});
