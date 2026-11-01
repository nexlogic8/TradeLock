import { getRules, saveRules } from './service.js';
import { capitalFor, getDashboard, dayState, patchDay } from '../risk/service.js';
import { limitsFor } from './limits.js';
import { emit } from '../../lib/bus.js';
import { audit } from '../audit/service.js';
import { config } from '../../config.js';

/**
 * Flexible-discipline accounts (FLEX_USER_IDS): after a rule change, a pause from a rule that the day no longer breaks
 * (the loss is back inside a raised daily loss limit, or the rule was switched off) is lifted for the rest of today.
 */
function liftPauseIfInside(userId, active, ip) {
  if (!config.flexUserIds.has(userId)) return false;
  const s = dayState(userId);
  if (!s.paused || !String(s.pause_reason || '').startsWith('rule:')) return false;
  const rule = s.pause_reason.slice(5), pnl = s.realized + s.unrealized, lim = limitsFor(active, capitalFor(userId, s));
  const stillHit = rule === 'maxLoss' ? active.maxLoss?.on && lim.maxLoss > 0 && pnl <= -lim.maxLoss
    : rule === 'profitLock' ? active.profitLock?.on && lim.profitLock > 0 && pnl >= lim.profitLock
    : !!active[rule]?.on;
  if (stillHit) return false;
  patchDay(userId, s.day, { paused: 0, pause_reason: null, fired: (s.fired || []).filter(f => !f.startsWith(`${rule}.`)) });
  audit(userId, 'rules.pause_lifted', { rule, pnl, limit: lim[rule] ?? null }, ip);
  return true;
}

export function rulesRoutes(r) {
  r.get('/api/rules', ctx => ({ ...getRules(ctx.user.id), capital: capitalFor(ctx.user.id) }));
  r.put('/api/rules', ctx => {
    const saved = saveRules(ctx.user.id, ctx.body.rules ?? ctx.body, ctx.ip, capitalFor(ctx.user.id));
    liftPauseIfInside(ctx.user.id, saved.active, ctx.ip);
    // Every open screen (Overview chart, cutoff, limits) picks up the new rules at once.
    emit(ctx.user.id, 'snapshot', getDashboard(ctx.user.id));
    return { ...saved, capital: capitalFor(ctx.user.id) };
  });
}
