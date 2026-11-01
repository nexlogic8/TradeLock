import { getStrategy, saveStrategy, listStrategies, createStrategy, updateStrategy, deleteStrategy, DEFAULT_STRATEGY } from './service.js';

export function strategyRoutes(r) {
  // Saved strategies: list, create, update, delete.
  r.get('/api/strategies', ctx => ({ items: listStrategies(ctx.user.id), template: DEFAULT_STRATEGY }));
  r.post('/api/strategies', ctx => { ctx.status = 201; return { strategy: createStrategy(ctx.user.id, ctx.body.strategy ?? ctx.body, ctx.ip) }; });
  r.put('/api/strategies/:id', ctx => ({ strategy: updateStrategy(ctx.user.id, ctx.params.id, ctx.body.strategy ?? ctx.body, ctx.ip) }));
  r.delete('/api/strategies/:id', ctx => deleteStrategy(ctx.user.id, ctx.params.id, ctx.ip));
  // Older single-playbook API (kept for existing clients).
  r.get('/api/strategy', ctx => ({ strategy: getStrategy(ctx.user.id) }));
  r.put('/api/strategy', ctx => ({ strategy: saveStrategy(ctx.user.id, ctx.body.strategy ?? ctx.body, ctx.ip) }));
}
