#!/usr/bin/env bash
# Build and (re)start the stack on the server. Safe to run for every update.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing deploy/.env — copy .env.example and fill it in."; exit 1; }
grep -qE '^APP_SECRET=.{32,}' .env || { echo "APP_SECRET in deploy/.env must be at least 32 characters."; exit 1; }
grep -qE '^DOMAIN=.+' .env || { echo "Set DOMAIN in deploy/.env."; exit 1; }

docker compose --env-file .env build app
docker compose --env-file .env up -d
docker image prune -f >/dev/null

echo "==> Waiting for health check"
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "TradeLock is up. Visit https://$(grep '^DOMAIN=' .env | cut -d= -f2)"
    exit 0
  fi
  sleep 2
done
echo "Health check failed. Logs:"; docker compose logs --tail=50 app; exit 1
