#!/bin/sh
# Daily, right after the market closes: add the day's NIFTY, BANK NIFTY and SENSEX 1-minute index and option candles to
# /app/data/history.db, so backtests include today from about 15:40 IST. Resumable and capped like the backfill; a holiday
# finds nothing new. Requests are logged per date range, so the 16:30 catch-up uses a 5-day range (a different key) and
# fetches the last days again, in case Dhan had not published all of today's candles at 15:35. Installed with:
#   35 15 * * 1-5 /home/ubuntu/tradelock/deploy/history-daily.sh
#   30 16 * * 1-5 /home/ubuntu/tradelock/deploy/history-daily.sh 5
DAYS=${1:-4}
cd /home/ubuntu/tradelock/deploy || exit 1
TODAY=$(TZ=Asia/Kolkata date +%F)
/usr/bin/docker compose exec -T app sh -c "node server/src/workers/history-backfill.js --to $TODAY --days $DAYS --pause 800 --window 1 --max-per-day 5000 >> /app/data/backfill-daily.log 2>&1"
# BANK NIFTY and SENSEX: ATM ± 10 (a big gap day opens far from the previous close; slot 2 is ± 3, the most Dhan serves).
for U in BANKNIFTY SENSEX; do
  /usr/bin/docker compose exec -T app sh -c "node server/src/workers/history-backfill.js --underlying $U --to $TODAY --days $DAYS --pause 800 --window 1 --max-offset 10 --max-per-day 5000 >> /app/data/backfill-daily.log 2>&1"
done
