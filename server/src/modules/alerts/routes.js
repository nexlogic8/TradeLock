// Price alerts from the Power Scalper chart: list, add, move (drag), remove.
import { v } from '../../lib/validate.js';
import { bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { activeAlerts, createAlert, moveAlert, deleteAlert } from './service.js';
import { trackPositions } from '../risk/live-pnl.js';

const SEGMENTS = ['NSE_FNO', 'BSE_FNO', 'MCX_COMM', 'IDX_I', 'NSE_EQ', 'BSE_EQ'];
const priceOf = (x, name) => v.num(x, name, { min: 0.05, max: 10_000_000 });
const ltpOf = x => (Number(x) > 0 ? Number(x) : null);

export function alertRoutes(r) {
  r.get('/api/alerts', ctx => ({ alerts: activeAlerts(ctx.user.id) }));
  r.post('/api/alerts', ctx => {
    limit(`alerts:${ctx.user.id}`, 60, 60_000);
    const b = ctx.body || {};
    if (!SEGMENTS.includes(b.segment)) throw bad('ALERT_SEGMENT', 'This chart cannot take an alert.');
    const alert = createAlert(ctx.user.id, { segment: b.segment, securityId: v.str(String(b.securityId ?? ''), 'Contract', { min: 1, max: 30 }),
      symbol: v.str(String(b.symbol ?? ''), 'Symbol', { min: 1, max: 80 }), price: priceOf(b.price, 'Alert price'), ltp: ltpOf(b.ltp) });
    trackPositions(ctx.user.id);   // the feed now follows this contract
    ctx.status = 201;
    return { alert };
  });
  r.put('/api/alerts/:id', ctx => {
    limit(`alerts:${ctx.user.id}`, 60, 60_000);
    return { alert: moveAlert(ctx.user.id, Number(ctx.params.id), { price: priceOf(ctx.body?.price, 'Alert price'), ltp: ltpOf(ctx.body?.ltp) }) };
  });
  r.delete('/api/alerts/:id', ctx => { deleteAlert(ctx.user.id, Number(ctx.params.id)); trackPositions(ctx.user.id); return { ok: true }; });
}
