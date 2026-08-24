#!/usr/bin/env bash
# Creates a timestamped, compressed backup of a SQLite DB, then prunes old
# backups for that same DB down to a fixed retention count. This is the fix
# for the item flagged 2026-08-22: manual pre-change backups (data/dse.db.bak-*,
# pipeline/data/staging.db.bak-*) were being created ad hoc with no compression
# and no cleanup, growing unbounded (2.5GB across 11 backups from one day).
#
# Usage: scripts/backup_db.sh <path-to-db> <label> [keep_count]
#   <path-to-db>  e.g. data/dse.db or pipeline/data/staging.db
#   <label>       short reason, e.g. prepromote, pretiersourcebackfill
#   [keep_count]  how many compressed backups to retain for this DB (default 5)
#
# Uses `sqlite3 .backup` (not `cp`) so a WAL-mode DB with pending
# uncommitted-to-main-file writes still produces a consistent snapshot --
# a plain `cp` of the main .db file alone can miss data still sitting in the
# -wal sidecar file.

set -euo pipefail

DB_PATH="${1:?Usage: backup_db.sh <path-to-db> <label> [keep_count]}"
LABEL="${2:?Usage: backup_db.sh <path-to-db> <label> [keep_count]}"
KEEP="${3:-5}"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup_db] No such file: $DB_PATH" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="${DB_PATH}.bak-${TS}-${LABEL}"

echo "[backup_db] Backing up $DB_PATH -> ${OUT}.gz"
sqlite3 "$DB_PATH" ".backup '${OUT}'"
gzip -f "$OUT"

echo "[backup_db] Pruning ${DB_PATH}.bak-* to the newest ${KEEP}..."
# List matching backups oldest-first, drop the newest $KEEP, delete the rest.
ls -1t "${DB_PATH}".bak-*.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  echo "[backup_db]   removing old backup: $old"
  rm -f -- "$old"
done

echo "[backup_db] Done. Current backups for $DB_PATH:"
ls -lh "${DB_PATH}".bak-*.gz 2>/dev/null || echo "  (none)"
