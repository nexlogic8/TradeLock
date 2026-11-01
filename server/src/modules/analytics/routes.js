import { analytics, pnlCalendar } from './service.js';
import { ist } from '../../lib/time.js';
import { getDashboard } from '../risk/service.js';
import { syncBrokerPnl } from './brokerpnl.js';

export function analyticsRoutes(r) {
  r.get('/api/analytics', ctx => {
    const sessions = Math.min(250, Math.max(5, Number(ctx.query.sessions) || 20));
    return { ...analytics(ctx.user.id, sessions), maxLoss: getDashboard(ctx.user.id).limits.maxLoss };
  });

  r.get('/api/analytics/calendar', ctx => {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(ctx.query.month || '') ? ctx.query.month : ist().day.slice(0, 7);
    return pnlCalendar(ctx.user.id, month);
  });

  // "Sync from Dhan": pull new fills from the broker's trade history and rebuild the daily P&L.
  r.post('/api/analytics/broker-sync', async ctx => {
    const res = await syncBrokerPnl(ctx.user.id, { manual: true });
    return { ok: true, ...res, state: undefined };
  });
}
