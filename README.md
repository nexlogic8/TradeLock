# TradeLock

Risk-first trading discipline for Indian F&O traders. TradeLock does the following:

- Watches a broker account (Dhan first) every 2 seconds.
- Enforces a daily loss limit, a trade cap, a profit lock and a cutoff time.
- Gates orders placed through it.
- Runs emergency actions: pause, cancel and exit.
- Offers an AI options proposal screen in paper mode (NIFTY CE/PE buy ideas; no broker orders).
- Offers Power Scalper with NIFTY/option charts, an option-chain view, and live Dhan market ticks.
- Always says what it can and cannot enforce.

**Stack:** Node 20+ with no web framework. SQLite (`better-sqlite3`) is the only runtime dependency. The web client is plain ES modules, with no build step and no front-end framework.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # 20 tests: rules engine, order gate, crypto, HTTP end-to-end
```

On the first start in development, the server seeds a demo account (`demo@tradelock.local` / `demo1234`). The demo account comes with:

- a simulated broker,
- 19 past sessions of history,
- affiliate data.

The sign-in page has a **Use the demo account** button. The **Simulate 45s outage** button in the sidebar lets you watch monitoring go *delayed* and then *degraded* (after 30 s), and then recover.

Use `npm run dev` to restart automatically on file changes. Copy `.env.example` to `.env` to configure the server.

## Layout

```
server/src/
  index.js              boot: HTTP server, monitor loop, housekeeping, graceful shutdown
  config.js             env + .env loader, one frozen config object
  lib/                  framework-free building blocks
    app.js              request pipeline: security headers, CSRF origin check, JSON, auth, errors
    http.js             tiny router, body/cookie helpers
    static.js           serves web/ with ETags and SPA fallback
    crypto.js           scrypt passwords, AES-256-GCM token encryption, TOTP (RFC 6238)
    time.js             IST trading-day clock, market hours
    bus.js              in-process pub/sub feeding Server-Sent Events
    validate.js, ratelimit.js, errors.js
  db/                   schema migrations (PRAGMA user_version), connection, demo seed
  modules/              one folder per feature: routes.js (HTTP) + service.js (logic)
    auth/               signup, login, sessions (hashed tokens), MFA
    rules/              rule config; loosening mid-session is deferred to next trading day
    risk/
      engine.js         PURE: evaluate(rules, snapshot) → triggers; countEntries(fills)
      gate.js           PURE: checkOrder(order, state) → allow/block (exits always allowed)
      monitor.js        poll brokers → update day state → evaluate → act → push to clients
      service.js        day state, intraday points, dashboard snapshot
    broker/
      registry.js       adapter contract + catalog; add a broker here
      adapters/dhan.js  DhanHQ v2 REST adapter
      adapters/mock.js  simulated NIFTY options book for demo/dev
    orders/             order entry through the risk gate, cancel, exit
    emergency/          pause / cancel / exit with per-action results and acknowledgement
    trades/ analytics/ notifications/ billing/ affiliate/ settings/ audit/ stream/
server/test/            node:test suites (no test framework dependency)

web/
  index.html, css/      tokens → base → components → layout → pages
  js/core/              router (lazy page modules), store, api client, SSE stream, formatting
  js/ui/                shell (sidebar/topbar/banners), charts (SVG), icons, toasts, parts
  js/pages/             one module per screen: load → view → draw → mount
```

On phones the app shows a bottom tab bar, tables turn into cards, and it can be installed to the home screen (`web/manifest.webmanifest`).

### AI Algo Trading (paper mode)

The AI Algo screen is an on-demand paper-analysis foundation. It reads Dhan's NIFTY option chain, asks the OpenAI Responses API for a constrained `BUY_CE`, `BUY_PE`, or `NO_TRADE` proposal, then verifies the chosen strike against the supplied chain and configured premium, spread, and confidence. TradeLock does not impose a daily or per-minute cap on AI proposals; broker/API availability and provider limits still apply. Paper entries retain their own risk controls. Proposals and failed analyses are recorded for audit. It does not place or manage broker orders and is not an unattended trading service.

To enable analysis, configure `OPENAI_API_KEY` on the server and optionally set `OPENAI_MODEL`; never expose the key in the browser, Android app, or committed source. Dhan option-chain access and TradeLock protection must also be available. The key is optional during development, and the paper screen remains disabled until the server has it.

The design prototype is in `tradelock.html`. The app reproduces it with live data.

### Power Scalper

Power Scalper uses the connected user's Dhan option-chain and intraday-candle APIs for the initial screen, then proxies Dhan's authenticated market-feed WebSocket through an authenticated TradeLock WebSocket. The Dhan token stays server-side. Dhan Data APIs must be active for the user's account. Buy and sell tickets require an in-app confirmation and use the existing TradeLock order route and risk gate; quantity is in units and must be a valid exchange lot multiple. This feature does not place orders automatically.

## How protection works

1. **Monitor.** The monitor polls every connected account every `SYNC_MS`. Dhan is polled during market hours only; the demo broker is polled all the time. Each poll:
   - stores fills,
   - recomputes day P&L, entries, worst point and peak,
   - records a point on the intraday chart.
2. **Engine.** The engine returns triggers. Each trigger fires once per day: it is recorded before anything acts on it, so a slow broker call can never fire it twice. The rules are:
   - loss warning at 80%, breach at 100%,
   - trade-cap warning at one entry left, breach at the cap,
   - profit lock,
   - cutoff (only inside the session).
3. **Actions.**
   - *alert* writes a notification.
   - *pause* blocks new entries through TradeLock for the rest of the day.
   - *exit* runs an emergency stop: pause, cancel open orders, exit positions.

   Exits and position-reducing orders are **never** blocked.
4. **Health.** A failed sync marks the account *delayed*. After `DEGRADED_AFTER_MS` with no successful sync it becomes *degraded*. An auth failure makes it *expired*. The UI drops every "protected" signal in any of those states.
5. **Rule changes.** Tightening a rule applies immediately. Loosening it during market hours (raising a limit, turning a rule off, weakening its action) is saved but takes effect on the next trading day.

## API

All routes are JSON under `/api`. All need a session cookie except the ones marked *public*.

| | |
|---|---|
| `POST /auth/signup` `/auth/login` `/auth/logout`, `GET /auth/me` | public |
| `POST /auth/mfa/setup` `/auth/mfa/enable` `/auth/mfa/disable` | TOTP |
| `GET /auth/google` → `GET /auth/google/callback`, `POST /auth/mfa/complete` | public: Google sign-in (PKCE), MFA step if enabled |
| `GET /dashboard`, `GET /dashboard/intraday` | live snapshot, intraday curve |
| `GET /rules`, `PUT /rules` | `{ rules }` → `{ active, pending, pendingFrom, deferred }` |
| `GET /brokers`, `POST /brokers/connect`, `POST /brokers/:id/reconnect`, `DELETE /brokers/:id` | |
| `POST /orders`, `DELETE /orders/:id`, `POST /positions/exit` | orders pass the risk gate |
| `POST /emergency`, `GET /emergency/latest`, `POST /emergency/:id/ack`, `POST /emergency/resume` | |
| `GET /trades`, `GET /analytics`, `GET /notifications`, `POST /notifications/read` | |
| `GET /billing`, `POST /billing/checkout` `/cancel` `/resume` | |
| `GET /affiliate`, `GET /r/:code` (public redirect) | |
| `GET/PATCH /settings`, `GET /audit`, `GET /stream` (SSE), `GET /health`, `GET /meta` | |

## Security

- **Passwords:** hashed with scrypt.
- **Google sign-in:** OAuth code flow with PKCE and a state cookie, and no SDK. When a verified Google email matches an existing password account, the old password is revoked and that account's sessions end, which blocks pre-account takeover.
- **Sessions:** random 256-bit tokens. Only their SHA-256 is stored. The cookie is HttpOnly and SameSite=Lax (plus Secure in production).
- **CSRF:** mutating requests with a foreign `Origin` are rejected, and request bodies must be JSON.
- **Broker tokens:** encrypted with AES-256-GCM using a key derived from `APP_SECRET`. They are never returned by the API.
- **Response headers:** strict CSP (`script-src 'self'`), no framing, nosniff.
- **Rate limits:** on login, signup, broker connect, orders and emergency actions.
- **Emergency stop:** requires typing `STOP` (configurable). It also requires a TOTP code when MFA is on.
- **Audit:** every rule change, order, block, connection and emergency action goes to `audit_log`.

## Before going live

- **Dhan adapter:** written against the public DhanHQ v2 docs. Verify the endpoints and field names, and order placement permissions, on a real account first.
- **Payments:** `POST /billing/checkout` returns 501 until a provider is added. A Razorpay subscription, for example, would call `activateSubscription()` from its webhook (`modules/billing/service.js`).
- **Holidays:** `lib/time.js` knows weekends but not NSE holidays. Add the exchange holiday calendar.
- **Scaling:** state (live positions, the event bus, rate limits) lives in a single process. Running more than one instance needs Redis or similar for `bus.js`, `book.js` and `ratelimit.js`.
- **Production setup:** set `NODE_ENV=production`, a strong `APP_SECRET` and `PUBLIC_URL`, and run behind HTTPS with `TRUST_PROXY=1`. Production mode hides the demo broker and demo credentials.
