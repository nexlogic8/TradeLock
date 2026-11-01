import { getDashboard, intradayPoints } from './service.js';
import { ist } from '../../lib/time.js';

export function riskRoutes(r) {
  r.get('/api/dashboard', ctx => getDashboard(ctx.user.id));
  r.get('/api/dashboard/intraday', ctx => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.day || '') ? ctx.query.day : ist().day;
    return { day, points: intradayPoints(ctx.user.id, day) };
  });
}
