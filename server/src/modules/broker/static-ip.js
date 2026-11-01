// Each user's own static IP, for the broker's whitelist (SEBI: one static IP serves one client account).
// Addresses come from the server's IPv6 block (IPV6_POOL, an AWS /80 or Google Cloud /96 prefix routed to this server: the address is
// the block plus the user id, so it never changes and never collides). A few accounts were mapped by hand to the
// server's main IPv4 or IPv6 before the block existed; those rows stay as they are.
import { stmt } from '../../db/index.js';
import { config } from '../../config.js';
import { serverIp, serverIpv6 } from '../../lib/serverip.js';

/** Canonical text form of an IP (lower-case, IPv6 zero-compressed), so addresses compare reliably. */
export function canonicalIp(ip) {
  const s = String(ip || '').trim();
  if (!s.includes(':')) return s;
  try { return new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch { return s.toLowerCase(); }
}

/** The user's address inside the IPv6 block, or null when no block is configured. */
export function poolAddress(userId, pool = config.ipv6Pool) {
  const m = /^([0-9a-f:]+)\/(80|96)$/i.exec(String(pool || '').trim());
  const base = m && canonicalIp(m[1]);
  if (!base?.endsWith('::') || !(userId > 0)) return null;
  return canonicalIp(`${base}${Number(userId).toString(16)}`);
}

/** { ip, family } for this user, assigning one from the block on first use; null without a block or a hand mapping. */
export function staticIpFor(userId) {
  const row = stmt('SELECT ip, family FROM static_ips WHERE user_id = ?').get(userId);
  if (row) return row;
  const ip = poolAddress(userId);
  if (!ip) return null;
  stmt('INSERT OR IGNORE INTO static_ips (user_id, ip, family, assigned_at) VALUES (?, ?, 6, ?)').run(userId, ip, Date.now());
  return stmt('SELECT ip, family FROM static_ips WHERE user_id = ?').get(userId);
}

/** How this user's broker calls leave the server: their own address, or null (server default). */
export function egressFor(userId) {
  const s = staticIpFor(userId);
  if (!s) return null;
  return s.family === 6 ? { family: 6, localAddress: s.ip } : { family: 4 };
}

/** What the connect screen shows: the user's own IP, or (no block yet) the server's shared addresses. */
export function staticIpView(userId) {
  const s = staticIpFor(userId);
  if (s) return { ip: s.ip, family: s.family, own: true };
  return { ip: serverIp() || '34.93.19.54', alt: serverIpv6(), family: 4, own: false };
}
