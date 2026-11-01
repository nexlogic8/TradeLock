import { stmt } from '../../db/index.js';

export function audit(userId, action, detail = {}, ip = null) {
  stmt('INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, JSON.stringify(detail), ip, Date.now());
}

export const listAudit = (userId, limit = 50) =>
  stmt('SELECT id, action, detail, created_at AS createdAt FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit)
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }));
