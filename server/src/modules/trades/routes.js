import { listTrades } from './service.js';
import { ist } from '../../lib/time.js';

export function tradesRoutes(r) {
  r.get('/api/trades', ctx => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.day || '') ? ctx.query.day : ist().day;
    return listTrades(ctx.user.id, day);
  });
}
