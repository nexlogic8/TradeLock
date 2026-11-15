// PUT /api/brackets { securityId, tp, sl }: set the target / stop of an open position from the Power Scalper chart
// (null clears one; both null removes the bracket and cancels the stop order at the broker).
import { v } from '../../lib/validate.js';
import { bad } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { accountFor } from '../broker/registry.js';
import { setBracket } from './service.js';
import { bracketsFor } from './store.js';

const price = (x, name) => (x == null || x === '' ? null : v.num(x, name, { min: 0.05, max: 1_000_000 }));

export function bracketRoutes(r) {
  r.get('/api/brackets', ctx => ({ brackets: bracketsFor(ctx.user.id) }));
  r.put('/api/brackets', async ctx => {
    limit(`bracket:${ctx.user.id}`, 60, 60_000);
    const acct = accountFor(ctx.user.id);
    if (!acct) throw bad('NO_BROKER', 'Connect a broker first.');
    const b = ctx.body || {};
    const securityId = v.str(String(b.securityId ?? ''), 'Contract', { min: 1, max: 30 });
    return { bracket: await setBracket(ctx.user.id, acct, { securityId, tp: price(b.tp, 'Target'), sl: price(b.sl, 'Stop-loss') }, ctx.ip) };
  });
}
