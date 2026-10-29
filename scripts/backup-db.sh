#!/usr/bin/env bash
# Online SQLite backup from the running backend container; keeps the newest 14.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
docker exec home-security-backend node -e "
  const Database = require('better-sqlite3');
  new Database(process.env.DB_PATH, { readonly: true })
    .backup('/data/backup-tmp.sqlite')
    .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
"
docker cp home-security-backend:/data/backup-tmp.sqlite "$BACKUP_DIR/data-$STAMP.sqlite"
docker exec home-security-backend rm -f /data/backup-tmp.sqlite
gzip "$BACKUP_DIR/data-$STAMP.sqlite"

ls -1t "$BACKUP_DIR"/data-*.sqlite.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup written: $BACKUP_DIR/data-$STAMP.sqlite.gz"
