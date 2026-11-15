import { Router } from '../lib/http.js';
import { config } from '../config.js';
import { CATALOG } from './broker/registry.js';
import { authRoutes } from './auth/routes.js';
import { googleRoutes, googleEnabled } from './auth/google.js';
import { razorpayEnabled } from './wallet/razorpay.js';
import { serverIp, serverIpv6 } from '../lib/serverip.js';
import { rulesRoutes } from './rules/routes.js';
import { strategyRoutes } from './strategy/routes.js';
import { algoRoutes } from './algo/routes.js';
import { scalperRoutes } from './scalper/routes.js';
import { riskRoutes } from './risk/routes.js';
import { brokerRoutes } from './broker/routes.js';
import { stoxkartRoutes } from './broker/stoxkart.js';
import { ordersRoutes } from './orders/routes.js';
import { bracketRoutes } from './brackets/routes.js';
import { emergencyRoutes } from './emergency/routes.js';
import { tradesRoutes } from './trades/routes.js';
import { analyticsRoutes } from './analytics/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { billingRoutes } from './billing/routes.js';
import { affiliateRoutes } from './affiliate/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { auditRoutes } from './audit/routes.js';
import { streamRoutes } from './stream/routes.js';
import { walletRoutes } from './wallet/routes.js';
import { adminRoutes } from './admin/routes.js';
import { journalRoutes } from './journal/routes.js';

export function buildRouter() {
  const r = new Router();
  r.get('/api/health', () => ({ ok: true, time: Date.now() }), { public: true });
  r.get('/api/meta', () => ({
    plan: config.plan,
    brokers: CATALOG,
    demo: config.isProd ? null : config.demo,
    google: googleEnabled(),
    serverIp: serverIp(),
    serverIpv6: serverIpv6(),
    payments: razorpayEnabled() ? 'razorpay' : config.isProd ? null : 'simulated',
    dev: !config.isProd,
  }), { public: true });

  for (const register of [
    authRoutes, googleRoutes, rulesRoutes, strategyRoutes, algoRoutes, scalperRoutes, riskRoutes, brokerRoutes, stoxkartRoutes, ordersRoutes, bracketRoutes, emergencyRoutes, tradesRoutes,
    analyticsRoutes, notificationRoutes, billingRoutes, affiliateRoutes, settingsRoutes, auditRoutes, streamRoutes, walletRoutes, adminRoutes, journalRoutes,
  ]) register(r);
  return r;
}
