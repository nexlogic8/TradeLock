#!/usr/bin/env bash
# Consistent online SQLite backup out of the running container; keeps 14 days locally.
# Optional off-site copy: set S3_BUCKET (and install the AWS CLI with an instance role that can write to it).
set -euo pipefail
cd "$(dirname "$0")"
DEST="$HOME/backups"
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$DEST"

docker compose exec -T app node -e "
  const D = require('better-sqlite3');
  new D('/app/data/tradelock.db', { readonly: true }).backup('/app/data/backup.db').then(() => console.log('ok'));
"
docker compose cp app:/app/data/backup.db "$DEST/tradelock-$STAMP.db"
docker compose exec -T app rm -f /app/data/backup.db
gzip -f "$DEST/tradelock-$STAMP.db"
find "$DEST" -name 'tradelock-*.db.gz' -mtime +14 -delete

if [ -n "${S3_BUCKET:-}" ] && command -v aws >/dev/null; then
  aws s3 cp "$DEST/tradelock-$STAMP.db.gz" "s3://$S3_BUCKET/backups/"
fi
echo "$(date) backup ok: tradelock-$STAMP.db.gz"
