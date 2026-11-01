import { createServer } from 'node:http';
import { config } from './config.js';
import { db, stmt, flushWrites } from './db/index.js';
import { createHandler } from './lib/app.js';
import { buildRouter } from './modules/index.js';
import { startMonitor } from './modules/risk/monitor.js';
import { startBrokerPnlSync } from './modules/analytics/brokerpnl.js';
import { purgeExpiredSessions } from './modules/auth/session.js';
import { seedDemo } from './db/seed.js';
import { detectServerIp, detectServerIpv6 } from './lib/serverip.js';
import { startAlerts } from './modules/admin/alerts.js';
import { startAlgoScanner } from './modules/algo/service.js';
import { attachScalperWebSocket } from './modules/scalper/live.js';
import { startAutoTrader } from './modules/scalper/autotrade.js';
import { startScalperWarmup } from './modules/scalper/routes.js';

if (!config.isProd && stmt('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seedDemo();
  console.log(`Seeded demo account: ${config.demo.email} / ${config.demo.password}`);
}

const server = createServer(createHandler(buildRouter()));
const stopScalperFeed = attachScalperWebSocket(server);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`TradeLock listening on http://${config.host}:${server.address().port}`);
});

const stopMonitor = config.monitor ? startMonitor() : () => {};
const stopAlerts = startAlerts();
const stopPnlSync = config.monitor ? startBrokerPnlSync() : () => {};
const stopAlgoScanner = startAlgoScanner();
const stopAutoTrader = config.monitor ? startAutoTrader() : () => {};
const stopScalperWarmup = config.monitor ? startScalperWarmup() : () => {};
detectServerIp().then(ip => ip && console.log(`Public IP for broker whitelisting: ${ip}`));
detectServerIpv6().then(ip => ip && console.log(`Public IPv6 for broker whitelisting: ${ip}`));
purgeExpiredSessions();
const housekeeping = setInterval(purgeExpiredSessions, 3600e3);
housekeeping.unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopMonitor();
  stopAlerts();
  stopPnlSync();
  stopAlgoScanner();
  stopAutoTrader();
  stopScalperWarmup();
  stopScalperFeed();
  server.close(() => { flushWrites(); db.close(); process.exit(0); });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
