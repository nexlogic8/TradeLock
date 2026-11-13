import { stmt } from '../../db/index.js';
import { bad, HttpError } from '../../lib/errors.js';
import { verifyTotp } from '../../lib/crypto.js';
import { limit } from '../../lib/ratelimit.js';
import { ACTIONS, startEmergency, latestEmergency, acknowledge, resumeOrders, releaseKillSwitch } from './service.js';

export function emergencyRoutes(r) {
  r.get('/api/emergency/latest', ctx => ({ record: latestEmergency(ctx.user.id) }));

  r.post('/api/emergency', ctx => {
    limit(`emergency:${ctx.user.id}`, 10, 60e3);
    const input = Array.isArray(ctx.body.actions) ? ctx.body.actions : [];
    const actions = ACTIONS.filter(a => input.includes(a));
    if (!actions.length || actions.length !== new Set(input).size) throw bad('VALIDATION', `Choose at least one of: ${ACTIONS.join(', ')}`);
    if (ctx.user.prefs.emergencyConfirm !== false && ctx.body.confirm !== 'STOP') throw bad('CONFIRM_REQUIRED', 'Type STOP to confirm.');
    if (ctx.user.mfaEnabled) {
      const { mfa_secret: secret } = stmt('SELECT mfa_secret FROM users WHERE id = ?').get(ctx.user.id);
      if (!verifyTotp(secret, ctx.body.code)) throw new HttpError(401, 'MFA_INVALID', 'Enter a valid 6-digit code from your authenticator app.');
    }
    const { record } = startEmergency(ctx.user.id, actions, 'manual');
    ctx.status = 202;
    return { record };
  });

  r.post('/api/emergency/:id/ack', ctx => ({ record: acknowledge(ctx.user.id, ctx.params.id) }));
  r.post('/api/emergency/resume', ctx => resumeOrders(ctx.user.id));
  // Switch the broker's kill switch off (allowed the same day).
  r.post('/api/emergency/killswitch/off', async ctx => {
    limit(`ks-off:${ctx.user.id}`, 5, 60e3);
    if (ctx.user.mfaEnabled) {
      const { mfa_secret: secret } = stmt('SELECT mfa_secret FROM users WHERE id = ?').get(ctx.user.id);
      if (!verifyTotp(secret, ctx.body.code)) throw new HttpError(401, 'MFA_INVALID', 'Enter a valid 6-digit code from your authenticator app.');
    }
    return releaseKillSwitch(ctx.user.id);
  });
}
