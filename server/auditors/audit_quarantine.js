import { fileURLToPath } from 'url';
import { initDB, getPendingQuarantineConflicts, dbAll, saveMainDBAuditReport } from '../db.js';

export async function auditQuarantine() {
  await initDB();
  console.log('\n======================================================');
  console.log('   DATA QUARANTINE & CONFLICT AUDIT');
  console.log('======================================================\n');

  const pending = await getPendingQuarantineConflicts();
  const allResolved = await dbAll(`SELECT COUNT(*) as c FROM data_quarantine WHERE status != 'PENDING_USER_APPROVAL'`);
  const resolvedCount = allResolved[0]?.c || 0;

  console.log(`Resolved Conflicts in Archive : ${resolvedCount}`);
  console.log(`Pending Conflicts Awaiting You: ${pending.length}\n`);

  const clean = pending.length === 0;
  const status = clean ? 'CERTIFIED_PASSED' : 'AUDIT_FAILED';

  if (clean) {
    console.log('✅ \x1b[32mALL DATA IS CLEAN & UNCONFLICTED\x1b[0m -- 0 unverified or conflicting cells.');
  } else {
    console.warn('⚠️ \x1b[33mACTION REQUIRED: Pending Data Conflicts Found\x1b[0m\n');
    console.table(pending.map(p => ({
      id: p.id,
      table: p.target_table,
      target: p.record_identifier,
      field: p.field_name,
      existing: p.existing_value,
      incoming: p.incoming_value,
      liveVerified: p.live_verified_value || '—',
      status: p.status,
      createdAt: p.created_at
    })));
    console.log('\nTo resolve these conflicts, review live exchange ground-truth and use the Admin Panel or API (/api/admin/quarantine/:id/resolve).');
  }
  console.log('======================================================\n');

  // Previously this auditor never persisted to audit_reports at all -- its
  // findings only ever existed in console output, invisible to the admin
  // Audit Reports history/dashboard.
  try {
    await saveMainDBAuditReport({
      targetEntity: 'DATA_QUARANTINE',
      recordsAudited: resolvedCount + pending.length,
      errorsCount: pending.length,
      warningsCount: 0,
      status,
      reportJson: { resolvedCount, pendingCount: pending.length, pending }
    });
  } catch (err) {
    console.error('[AUDITOR] Failed to save data quarantine audit report:', err.message);
  }

  return { clean, pendingCount: pending.length, pending, status };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  auditQuarantine()
    .then(res => {
      if (!res.clean) process.exit(1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
