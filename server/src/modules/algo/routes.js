import { limit } from '../../lib/ratelimit.js';
import { stmt } from '../../db/index.js';
import { accountFor } from '../broker/registry.js';
import { algoLive } from '../scalper/algo-live.js';
import { sessionInfo } from '../../lib/market-calendar.js';
import { algoStatus, analyzeOptions, closePaperTrade, openPaperTrade, recordAlgoFailure, refreshPaperTrades, saveAlgoConfig } from './service.js';

export function algoRoutes(r) {
  r.get('/api/algo', ctx => algoStatus(ctx.user.id));
  // Live Algo Trading (the page's switch, strategies and today's automatic trades).
  r.get('/api/algo/live', ctx => algoLive(ctx.user.id, accountFor(ctx.user.id)));
  // Android trade alarm: the app's background service asks for auto entries newer than the last one it
  // rang for. `after` = the last id it saw (0 = none yet); -1 on first start: only the latest id comes back.
  // `session` (trading day, today's open/close, next open, holidays) and `algoOn` let the app sleep outside market hours.
  r.get('/api/algo/entries', ctx => {
    limit(`algo-entries:${ctx.user.id}`, 40, 60e3);
    const n = Math.floor(Number(ctx.query.after)), after = Number.isFinite(n) ? Math.max(-1, n) : -1;
    const latestId = stmt('SELECT COALESCE(MAX(id), 0) AS id FROM auto_trades WHERE user_id = ? AND entry_price IS NOT NULL').get(ctx.user.id).id;
    const entries = after >= 0 ? stmt(`SELECT id, direction, symbol, lots, qty, entry_price AS entryPrice, sl_price AS slPrice, created_at AS createdAt,
        json_extract(detail, '$.setup.strategy') AS strategy FROM auto_trades
      WHERE user_id = ? AND id > ? AND entry_price IS NOT NULL ORDER BY id LIMIT 10`).all(ctx.user.id, after) : [];
    const algoOn = !!stmt('SELECT 1 FROM broker_accounts WHERE user_id = ? AND algo_on = 1 AND agent_on = 1 LIMIT 1').get(ctx.user.id);
    return { latestId, entries, serverTime: Date.now(), session: sessionInfo(), algoOn };
  });
  r.put('/api/algo', ctx => ({ config: saveAlgoConfig(ctx.user.id, ctx.body.config ?? ctx.body, ctx.ip) }));
  r.post('/api/algo/paper-trades/open', ctx => ({ trade: openPaperTrade(ctx.user.id, ctx.body, ctx.ip) }));
  r.post('/api/algo/paper-trades/close', ctx => ({ trade: closePaperTrade(ctx.user.id, ctx.body, ctx.ip) }));
  r.post('/api/algo/paper-trades/refresh', async ctx => {
    limit(`algo-paper-refresh:${ctx.user.id}`, 6, 60e3);
    return { paper: await refreshPaperTrades(ctx.user.id, ctx.ip) };
  });
  r.post('/api/algo/analyze', async ctx => {
    try { return { proposal: await analyzeOptions(ctx.user.id, ctx.ip) }; }
    catch (err) { recordAlgoFailure(ctx.user.id, err, ctx.ip); throw err; }
  });
}
