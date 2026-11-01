import { stmt } from '../../db/index.js';
import { v } from '../../lib/validate.js';
import { bad } from '../../lib/errors.js';
import { publicUser, DEFAULT_PREFS } from '../auth/service.js';
import { audit } from '../audit/service.js';

export function settingsRoutes(r) {
  r.get('/api/settings', ctx => ({ user: publicUser(ctx.user.id) }));

  r.patch('/api/settings', ctx => {
    const b = ctx.body;
    if (b.name !== undefined) {
      stmt('UPDATE users SET name = ? WHERE id = ?').run(v.str(b.name, 'Display name', { min: 1, max: 80 }), ctx.user.id);
    }
    if (b.phone !== undefined) {
      // Indian mobile: 10 digits starting 6-9, stored as +91XXXXXXXXXX. Empty clears it.
      const digits = String(b.phone || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
      if (digits && !/^[6-9]\d{9}$/.test(digits)) throw bad('VALIDATION', 'Enter a 10-digit Indian mobile number.', { field: 'phone' });
      stmt('UPDATE users SET phone = ? WHERE id = ?').run(digits ? `+91${digits}` : null, ctx.user.id);
    }
    if (b.prefs !== undefined) {
      const prefs = { ...DEFAULT_PREFS, ...ctx.user.prefs };
      for (const k of Object.keys(DEFAULT_PREFS)) if (k in b.prefs) prefs[k] = v.bool(b.prefs[k], k);
      stmt('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), ctx.user.id);
    }
    audit(ctx.user.id, 'settings.updated', { fields: Object.keys(b) }, ctx.ip);
    return { user: publicUser(ctx.user.id) };
  });
}
