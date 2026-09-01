/**
 * Automatic pre-flight backup for risky write paths (full-sync/prune scrapers,
 * first-enable of a previously-fabricating scraper, etc.) -- see
 * ARCHITECTURE.md's Known Incidents, most of which were recovered from a
 * manual `sqlite3 .backup` someone happened to run by hand right before the
 * risky change. `scripts/backup_db.sh` already existed for this (timestamped,
 * compressed, auto-pruned to a retention count) but was never actually
 * invoked by any code path -- every prior incident's backup was a human
 * remembering to run it first, not a safety net that always fires.
 *
 * Best-effort by design: a backup failure is logged loudly but never blocks
 * the caller's actual write -- holding a legitimate data sync hostage to a
 * missing `sqlite3` binary or a full disk would be worse than proceeding
 * without a fresh backup (the existing retained backups, if any, still cover
 * that case).
 */
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'dse.db');
const BACKUP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'backup_db.sh');

/**
 * Runs scripts/backup_db.sh against the live main DB with the given label.
 * Resolves to `{ ok: true }` on success or `{ ok: false, error }` on failure
 * -- never throws, so a caller can safely `await` this without its own
 * try/catch and without risking an unhandled rejection.
 */
export async function backupDatabaseBeforeRiskyRun(label) {
  const safeLabel = String(label || 'unlabeled').replace(/[^a-zA-Z0-9_-]/g, '_');
  return new Promise((resolve) => {
    execFile('bash', [BACKUP_SCRIPT, DB_PATH, safeLabel], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[BACKUP] Pre-flight backup failed for label "${safeLabel}" -- proceeding without a fresh backup:`, err.message, stderr || '');
        resolve({ ok: false, error: err.message });
        return;
      }
      console.log(`[BACKUP] Pre-flight backup completed (label "${safeLabel}").`);
      resolve({ ok: true, stdout });
    });
  });
}
