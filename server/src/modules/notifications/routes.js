import { bad } from '../../lib/errors.js';
import { listNotifications, unreadCount, markRead, deleteNotification } from './service.js';

export function notificationRoutes(r) {
  r.post('/api/notifications/delete', ctx => {
    const id = ctx.body.id;
    if (!Number.isSafeInteger(id) || id < 1) throw bad('VALIDATION', 'Send a valid notification id');
    return { unread: deleteNotification(ctx.user.id, id) };
  });
  r.get('/api/notifications', ctx => ({
    items: listNotifications(ctx.user.id, { kind: ctx.query.kind }),
    unread: unreadCount(ctx.user.id),
  }));

  r.post('/api/notifications/read', ctx => {
    const ids = ctx.body.ids === 'all' ? 'all' : Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 200) : null;
    if (!ids) throw bad('VALIDATION', 'Send ids as an array or "all"');
    return { unread: markRead(ctx.user.id, ids) };
  });
}
