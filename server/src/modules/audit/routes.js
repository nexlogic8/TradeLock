import { listAudit } from './service.js';

export function auditRoutes(r) {
  r.get('/api/audit', ctx => ({ items: listAudit(ctx.user.id, Math.min(200, Number(ctx.query.limit) || 50)) }));
}
