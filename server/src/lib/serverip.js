// The public IPv4 this server sends broker requests from. Brokers (Dhan, under SEBI rules) only accept
// API orders from a registered static IP, so users need to see this address while connecting.
import { config } from '../config.js';

import { request } from './httpclient.js';

let ip = config.publicIp || null;
let ip6 = config.publicIpv6 || null;

export const serverIp = () => ip;
/** The server's public IPv6: the static IP for a broker account whose IPv4 slot is taken by another account. */
export const serverIpv6 = () => ip6;

/** Learn the IPv6 broker calls leave from (once at boot when PUBLIC_IPV6 isn't set). Never throws. */
export async function detectServerIpv6() {
  if (ip6) return ip6;
  try {
    const res = await request('GET', 'https://api6.ipify.org', { family: 6, timeoutMs: 4000 });
    const text = res.text.trim().toLowerCase();
    if (res.status === 200 && /^[0-9a-f:]+$/.test(text) && text.includes(':')) ip6 = text;
  } catch { /* no IPv6 route: every account uses IPv4 */ }
  return ip6;
}

/** Ask AWS's echo service once at boot when PUBLIC_IP isn't configured. Never throws. */
export async function detectServerIp() {
  if (ip) return ip;
  try {
    const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(3000) });
    const text = (await res.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) ip = text;
  } catch { /* offline or blocked: the UI falls back to what the broker reports */ }
  return ip;
}

/** Tests only: pretend the server has these public addresses. */
export function setServerIpsForTest(v4, v6) { ip = v4; ip6 = v6; }
