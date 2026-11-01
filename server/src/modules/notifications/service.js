import { stmt } from '../../db/index.js';
import { emit } from '../../lib/bus.js';

export const KINDS = ['risk', 'broker', 'billing'];

const toItem = r => ({ id: r.id, kind: r.kind, level: r.level, title: r.title, body: r.body, read: !!r.read, createdAt: r.created_at });

export function notify(userId, { kind, level = 'info', title, body = '' }) {
  if (kind === 'broker' && level !== 'ok') {
    const prefs = JSON.parse(stmt('SELECT prefs FROM users WHERE id = ?').get(userId)?.prefs || '{}');
    if (prefs.brokerAlerts === false) return null;
  }
  const createdAt = Date.now();
  const { lastInsertRowid } = stmt('INSERT INTO notifications (user_id, kind, level, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, kind, level, title, body, createdAt);
  const item = { id: Number(lastInsertRowid), kind, level, title, body, read: false, createdAt };
  emit(userId, 'notification', item);
  return item;
}

export function listNotifications(userId, { kind, limit = 50 } = {}) {
  const rows = KINDS.includes(kind)
    ? stmt('SELECT * FROM notifications WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?').all(userId, kind, limit)
    : stmt('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  return rows.map(toItem);
}

export const unreadCount = userId =>
  stmt('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;

export function deleteNotification(userId, id) {
  stmt('DELETE FROM notifications WHERE user_id = ? AND id = ?').run(userId, id);
  return unreadCount(userId);
}

export function markRead(userId, ids) {
  if (ids === 'all') stmt('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
  else for (const id of ids) stmt('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(userId, Number(id));
  return unreadCount(userId);
}
