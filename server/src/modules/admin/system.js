// Server, AWS and platform health for the admin dashboard. Slow lookups are cached.
import os from 'node:os';
import fs from 'node:fs';
import tls from 'node:tls';
import path from 'node:path';
import { config } from '../../config.js';
import { metrics } from '../../lib/metrics.js';
import { serverIp } from '../../lib/serverip.js';

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** EC2 instance metadata (IMDSv2). Null when not on AWS. */
export const awsInstance = () => cached('aws', 6 * 3600e3, async () => {
  const base = 'http://169.254.169.254/latest';
  const token = await (await fetch(`${base}/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: AbortSignal.timeout(1500) })).text();
  const get = p => fetch(`${base}/meta-data/${p}`, { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1500) }).then(r => (r.ok ? r.text() : null));
  const [id, type, az, ip, ami] = await Promise.all(['instance-id', 'instance-type', 'placement/availability-zone', 'public-ipv4', 'ami-id'].map(get));
  return { instanceId: id, instanceType: type, availabilityZone: az, region: az?.slice(0, -1), publicIp: ip, amiId: ami };
});

/** Days until the site's HTTPS certificate expires. */
export const certDaysLeft = () => cached('cert', 6 * 3600e3, () => new Promise((resolve, reject) => {
  const host = new URL(config.publicUrl).hostname;
  if (host === 'localhost' || /^\d/.test(host)) return resolve(null);
  const s = tls.connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
    const cert = s.getPeerCertificate();
    s.end();
    resolve(cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 864e5) : null);
  });
  s.on('error', reject);
  s.on('timeout', () => s.destroy(new Error('timeout')));
}));

function latestBackup() {
  try {
    const files = fs.readdirSync(config.backupDir).filter(f => f.endsWith('.db.gz'))
      .map(f => ({ f, t: fs.statSync(path.join(config.backupDir, f)).mtimeMs }));
    if (!files.length) return { available: true, latestAt: null, count: 0 };
    files.sort((a, b) => b.t - a.t);
    return { available: true, latestAt: files[0].t, count: files.length };
  } catch { return { available: false }; }
}

function dbSize() {
  if (config.dbPath === ':memory:') return 0;
  return ['', '-wal'].reduce((n, sfx) => { try { return n + fs.statSync(config.dbPath + sfx).size; } catch { return n; } }, 0);
}

export async function systemHealth() {
  let disk = null;
  try {
    const s = fs.statfsSync(config.dbPath === ':memory:' ? '.' : path.dirname(config.dbPath));
    disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize, usedPct: Math.round((1 - s.bavail / s.blocks) * 1000) / 10 };
  } catch { /* unsupported */ }
  const total = os.totalmem(), free = os.freemem();
  return {
    host: os.hostname(),
    node: process.version,
    cpus: os.cpus().length,
    load: os.loadavg().map(x => Math.round(x * 100) / 100),
    memory: { totalBytes: total, freeBytes: free, usedPct: Math.round((1 - free / total) * 1000) / 10, processRss: process.memoryUsage().rss },
    disk,
    hostUptimeS: Math.round(os.uptime()),
    dbBytes: dbSize(),
    backup: latestBackup(),
    certDaysLeft: await certDaysLeft(),
    aws: await awsInstance(),
    serverIp: serverIp(),
    runtime: metrics(),
    monitorEnabled: config.monitor,
  };
}
