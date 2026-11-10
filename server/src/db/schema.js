// Append-only list of migrations. Index + 1 is stored in PRAGMA user_version.
// All timestamps are epoch milliseconds; `day` columns are IST trading dates (YYYY-MM-DD).
export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    currency      TEXT NOT NULL DEFAULT 'INR',
    mfa_secret    TEXT,
    mfa_pending   TEXT,
    mfa_enabled   INTEGER NOT NULL DEFAULT 0,
    prefs         TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE broker_accounts (
    id               INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker           TEXT NOT NULL,
    client_id        TEXT NOT NULL,
    token_enc        TEXT,
    status           TEXT NOT NULL DEFAULT 'connected',
    last_sync_at     INTEGER,
    last_error       TEXT,
    token_expires_at INTEGER,
    created_at       INTEGER NOT NULL,
    UNIQUE (user_id, broker)
  );

  CREATE TABLE risk_rules (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    config       TEXT NOT NULL,
    pending      TEXT,
    pending_from TEXT,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE day_state (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day          TEXT NOT NULL,
    realized     REAL NOT NULL DEFAULT 0,
    unrealized   REAL NOT NULL DEFAULT 0,
    worst        REAL NOT NULL DEFAULT 0,
    peak         REAL NOT NULL DEFAULT 0,
    entries      INTEGER NOT NULL DEFAULT 0,
    wins         INTEGER NOT NULL DEFAULT 0,
    losses       INTEGER NOT NULL DEFAULT 0,
    paused       INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    fired        TEXT NOT NULL DEFAULT '[]',
    breaches     INTEGER NOT NULL DEFAULT 0,
    blocked      INTEGER NOT NULL DEFAULT 0,
    sync_ok      INTEGER NOT NULL DEFAULT 0,
    sync_fail    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE pnl_points (
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,
    minute  INTEGER NOT NULL,
    pnl     REAL NOT NULL,
    PRIMARY KEY (user_id, day, minute)
  ) WITHOUT ROWID;

  CREATE TABLE trades (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('exec', 'event')),
    ext_id  TEXT NOT NULL,
    symbol  TEXT NOT NULL,
    side    TEXT NOT NULL,
    qty     INTEGER,
    price   REAL,
    pnl     REAL,
    status  TEXT NOT NULL,
    note    TEXT,
    UNIQUE (user_id, ext_id)
  );
  CREATE INDEX trades_user_day ON trades(user_id, day, ts);

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    level      TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

  CREATE TABLE emergency_actions (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actions         TEXT NOT NULL,
    source          TEXT NOT NULL,
    status          TEXT NOT NULL,
    results         TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    acknowledged_at INTEGER
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    ip         TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_user ON audit_log(user_id, created_at DESC);

  CREATE TABLE subscriptions (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan                 TEXT NOT NULL,
    status               TEXT NOT NULL,
    trial_ends_at        INTEGER,
    current_period_end   INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE affiliates (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code    TEXT NOT NULL UNIQUE,
    clicks  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE referrals (
    id                INTEGER PRIMARY KEY,
    affiliate_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status            TEXT NOT NULL DEFAULT 'trial',
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX referrals_affiliate ON referrals(affiliate_user_id, status);

  CREATE TABLE payouts (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period  TEXT NOT NULL,
    amount  REAL NOT NULL,
    status  TEXT NOT NULL,
    paid_at INTEGER
  );
  `,
  // 2: Google sign-in
  `
  ALTER TABLE users ADD COLUMN google_sub TEXT;
  CREATE UNIQUE INDEX users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
  `,
  // 3: percentage-of-capital limits. Starting capital is frozen per day; untouched old defaults
  //    (fixed ₹5,000 / ₹8,000) move to the new defaults (5% loss, 10% profit lock).
  `
  ALTER TABLE day_state ADD COLUMN capital REAL;
  UPDATE risk_rules SET config = '{"maxLoss":{"on":true,"mode":"percent","value":5,"action":"exit"},"maxTrades":{"on":true,"value":3,"action":"pause"},"profitLock":{"on":true,"mode":"percent","value":10,"action":"pause"},"cutoff":{"on":true,"value":"15:00","action":"pause"}}' WHERE config = '{"maxLoss":{"on":true,"value":5000,"action":"exit"},"maxTrades":{"on":true,"value":3,"action":"pause"},"profitLock":{"on":true,"value":8000,"action":"pause"},"cutoff":{"on":true,"value":"15:00","action":"pause"}}';
  `,
  // 4: broker kill switch. Per-day state: armed (reason) and when it was activated.
  //    Existing accounts get it switched on, as requested by the account owner.
  `
  ALTER TABLE day_state ADD COLUMN ks_armed TEXT;
  ALTER TABLE day_state ADD COLUMN ks_active_at INTEGER;
  UPDATE risk_rules SET config = json_set(config, '$.killSwitch', json('{"on":true}'))
    WHERE json_extract(config, '$.killSwitch') IS NULL;
  `,
  // 5: GROWCONTROL kill rules: 2 losing trades in a row, 20% give-back of booked profit (armed from ₹500).
  `
  UPDATE risk_rules SET config = json_set(config, '$.lossStreak', json('{"on":true,"value":2}'))
    WHERE json_extract(config, '$.lossStreak') IS NULL;
  UPDATE risk_rules SET config = json_set(config, '$.giveback', json('{"on":true,"value":20,"minProfit":500}'))
    WHERE json_extract(config, '$.giveback') IS NULL;
  `,
  // 6: TradeLock wallet. All amounts are integer paise. Two buckets per user:
  //    funds    = money the user added (closed wallet: spend on TradeLock only, not withdrawable)
  //    earnings = affiliate commissions (withdrawable, or spend on a subscription)
  //    The balance is the sum of the ledger; (user, bucket, type, ref) makes every credit idempotent.
  `
  CREATE TABLE wallet_ledger (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bucket     TEXT NOT NULL CHECK (bucket IN ('funds', 'earnings')),
    amount     INTEGER NOT NULL,
    type       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, bucket, type, ref)
  );
  CREATE INDEX wallet_ledger_user ON wallet_ledger(user_id, id DESC);

  CREATE TABLE payments (
    id                  INTEGER PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    provider_order_id   TEXT NOT NULL UNIQUE,
    provider_payment_id TEXT,
    amount              INTEGER NOT NULL,
    status              TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    paid_at             INTEGER
  );

  CREATE TABLE withdrawals (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount       INTEGER NOT NULL,
    method       TEXT NOT NULL,
    destination  TEXT NOT NULL,
    status       TEXT NOT NULL,
    note         TEXT,
    created_at   INTEGER NOT NULL,
    processed_at INTEGER,
    processed_by INTEGER
  );
  CREATE INDEX withdrawals_status ON withdrawals(status, created_at);
  `,
  // 7: optional mobile number, prefilled in payment checkout so it isn't asked every time.
  `
  ALTER TABLE users ADD COLUMN phone TEXT;
  `,
  // 8: the user can start/stop the TradeLock agent for their broker account.
  `
  ALTER TABLE broker_accounts ADD COLUMN agent_on INTEGER NOT NULL DEFAULT 1;
  `,
  // 9: a Razorpay payment is either a wallet top-up or (part of) a subscription purchase.
  `
  ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'topup';
  `,
  // 10: platform alerts for the admin dashboard (one open row per key until it resolves).
  `
  CREATE TABLE admin_alerts (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL,
    level       TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX admin_alerts_open ON admin_alerts(resolved_at, created_at DESC);
  `,
  // 11: profile picture (the Google account photo for Google sign-ins).
  `
  ALTER TABLE users ADD COLUMN avatar_url TEXT;
  `,
  // 12: background services (token keeper...) report their health here; the admin console reads it.
  `
  CREATE TABLE service_status (
    name           TEXT PRIMARY KEY,
    started_at     INTEGER,
    heartbeat_at   INTEGER,
    last_run_at    INTEGER,
    last_run_ms    INTEGER,
    last_result    TEXT,
    last_error     TEXT,
    next_run_at    INTEGER,
    run_requested  INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 13: P&L calendar from the broker's own trade history (fills, per-day results, sync state).
  `
  CREATE TABLE broker_fills (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ext_id   TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    day      TEXT NOT NULL,
    inst     TEXT NOT NULL,
    symbol   TEXT NOT NULL,
    side     TEXT NOT NULL,
    qty      REAL NOT NULL,
    price    REAL NOT NULL,
    charges  REAL NOT NULL DEFAULT 0,
    order_id TEXT NOT NULL DEFAULT '',
    option   INTEGER NOT NULL DEFAULT 0,
    expiry   TEXT,
    PRIMARY KEY (user_id, ext_id)
  ) WITHOUT ROWID;
  CREATE INDEX broker_fills_user_ts ON broker_fills(user_id, ts);
  CREATE TABLE broker_pnl_days (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    gross    REAL NOT NULL,
    charges  REAL NOT NULL,
    net      REAL NOT NULL,
    trades   INTEGER NOT NULL,
    wins     INTEGER NOT NULL,
    losses   INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  ) WITHOUT ROWID;
  CREATE TABLE broker_sync (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    broker    TEXT NOT NULL,
    from_day  TEXT NOT NULL,
    last_day  TEXT,
    last_at   INTEGER,
    status    TEXT NOT NULL DEFAULT 'idle',
    error     TEXT
  );
  `,
  // 14: one free trial per device and per broker account. Devices are stored as a keyed hash only.
  `
  CREATE TABLE device_links (
    device_hash TEXT NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (device_hash, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX device_links_user ON device_links(user_id);
  ALTER TABLE subscriptions ADD COLUMN trial_blocked TEXT;
  `,
  // 15: password reset links (single use, short-lived; only the token's hash is stored).
  `
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  // 16: coupons for the subscription (percent or flat off, N months, validity window, usage limits).
  `
  CREATE TABLE coupons (
    id              INTEGER PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    note            TEXT NOT NULL DEFAULT '',
    discount_type   TEXT NOT NULL CHECK (discount_type IN ('percent', 'flat')),
    discount_value  REAL NOT NULL,
    months          INTEGER NOT NULL DEFAULT 1,
    valid_from      INTEGER,
    valid_until     INTEGER,
    max_redemptions INTEGER,
    per_user_limit  INTEGER,
    new_users_only  INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    created_by      INTEGER,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE coupon_redemptions (
    id         INTEGER PRIMARY KEY,
    coupon_id  INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref        TEXT NOT NULL UNIQUE,
    months     INTEGER NOT NULL,
    base       INTEGER NOT NULL,
    discount   INTEGER NOT NULL,
    total      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
  CREATE INDEX coupon_redemptions_user ON coupon_redemptions(user_id);
  ALTER TABLE payments ADD COLUMN coupon_code TEXT;
  `,
  // 17: deleted accounts are kept as an anonymous row (payment records must stay), marked here.
  `
  ALTER TABLE users ADD COLUMN deleted_at INTEGER;
  `,
  // 18: the broker order a fill belongs to (one order can fill in many pieces; it is still one trade).
  `
  ALTER TABLE trades ADD COLUMN order_id TEXT;
  -- Dhan fill times (IST without a zone) were read as UTC, i.e. 5h30m late: move the old ones back.
  UPDATE trades SET ts = ts - 19800000 WHERE kind = 'exec' AND ext_id LIKE 'dhan:%' AND order_id IS NULL;
  `,
  `
  CREATE TABLE strategy_profiles (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    config     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE algo_profiles (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    config     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE algo_events (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    action     TEXT,
    detail     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX algo_events_user ON algo_events(user_id, id DESC);
  `,
  `
  CREATE TABLE algo_paper_trades (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proposal_id  INTEGER NOT NULL,
    security_id  TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('BUY_CE', 'BUY_PE')),
    strike       REAL NOT NULL,
    option_type  TEXT NOT NULL CHECK (option_type IN ('CE', 'PE')),
    expiry       TEXT NOT NULL,
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    entry_price  REAL NOT NULL,
    mark_price   REAL NOT NULL,
    exit_price   REAL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at    INTEGER NOT NULL,
    marked_at    INTEGER NOT NULL,
    closed_at    INTEGER,
    UNIQUE (user_id, proposal_id)
  );
  CREATE INDEX algo_paper_trades_user ON algo_paper_trades(user_id, status, opened_at DESC);
  `,
  `
  CREATE TABLE algo_scan_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_candle_at INTEGER NOT NULL DEFAULT 0,
    last_scan_at INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE algo_paper_trades ADD COLUMN auto_managed INTEGER NOT NULL DEFAULT 0;`,
  `
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL
  );
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  `ALTER TABLE backtest_runs ADD COLUMN exit_logic TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone'));`,
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_swing_sl;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic
    FROM backtest_runs_before_swing_sl;
  DROP TABLE backtest_runs_before_swing_sl;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Level-rejection exit (exit on the third rejection from the same level).
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_level_reject;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic
    FROM backtest_runs_before_level_reject;
  DROP TABLE backtest_runs_before_level_reject;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Backtest stop-loss rule, applied alongside the exit rule.
  `ALTER TABLE backtest_runs ADD COLUMN stop_logic TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'));`,
  // Nifty 5-Minute ORB strategy (settings live in metrics_json).
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_orb5;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_orb5;
  DROP TABLE backtest_runs_before_orb5;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Trading journal: one entry per note, newest day first.
  `
  CREATE TABLE journal_entries (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    mood        TEXT CHECK (mood IN ('great', 'good', 'neutral', 'bad', 'tilt')),
    discipline  INTEGER CHECK (discipline BETWEEN 1 AND 5),
    symbol      TEXT NOT NULL DEFAULT '',
    pnl         REAL,
    tags        TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX journal_user_day ON journal_entries(user_id, day DESC, id DESC);
  `,
  // Live ORB auto-trading: the per-account switch and one row per ORB signal it acted on (or skipped).
  `
  ALTER TABLE broker_accounts ADD COLUMN algo_on INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE auto_trades (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day               TEXT NOT NULL,
    signal_key        TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('CE', 'PE')),
    status            TEXT NOT NULL CHECK (status IN ('placing', 'open', 'closing', 'closed', 'failed', 'skipped')),
    reason            TEXT,
    security_id       TEXT,
    exchange_segment  TEXT,
    symbol            TEXT,
    expiry            TEXT,
    strike            REAL,
    lots              INTEGER,
    qty               INTEGER,
    entry_order_id    TEXT,
    entry_price       REAL,
    sl_price          REAL,
    sl_order_id       TEXT,
    exit_price        REAL,
    seen_open         INTEGER NOT NULL DEFAULT 0,
    detail            TEXT NOT NULL DEFAULT '{}',
    created_at        INTEGER NOT NULL,
    closed_at         INTEGER,
    UNIQUE (user_id, signal_key)
  );
  CREATE INDEX auto_trades_user ON auto_trades(user_id, id DESC);
  CREATE INDEX auto_trades_active ON auto_trades(status);
  `,
  // Algo Trading: EMA 9/21 crossover entries can be switched off on their own (ORB keeps running).
  `ALTER TABLE broker_accounts ADD COLUMN cross_on INTEGER NOT NULL DEFAULT 1;`,
  // ...and ORB 5m entries as well (the AI Algo Trading page switches each strategy on or off).
  `ALTER TABLE broker_accounts ADD COLUMN orb_on INTEGER NOT NULL DEFAULT 1;`,
  // Algo Trading: which index it trades (NIFTY 50 by default), and saved strategies (many per user;
  // the old single playbook becomes the first one).
  `
  ALTER TABLE broker_accounts ADD COLUMN algo_underlying TEXT NOT NULL DEFAULT 'NIFTY';
  CREATE TABLE user_strategies (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX user_strategies_user ON user_strategies(user_id, updated_at DESC);
  INSERT INTO user_strategies (user_id, config, created_at, updated_at) SELECT user_id, config, updated_at, updated_at FROM strategy_profiles;
  `,
  // Algo Trading: the 09:15 gap-open entry (1 lot), off until the user switches it on.
  `ALTER TABLE broker_accounts ADD COLUMN gap_on INTEGER NOT NULL DEFAULT 0;`,
  // Backtest: the Gap open 09:15 strategy (settings and both bounds live in metrics_json).
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_gap;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5', 'gap')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_gap;
  DROP TABLE backtest_runs_before_gap;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Manual trades alongside Algo Trading (off: manual entries refused and closed while it runs).
  `ALTER TABLE broker_accounts ADD COLUMN manual_on INTEGER NOT NULL DEFAULT 0;`,
  // Linked broker accounts that are not the active broker yet (StoxKart stage 1): encrypted credentials + last test.
  `
  CREATE TABLE broker_links (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker      TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    creds_enc   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'verified', 'failed')),
    last_error  TEXT,
    verified_at INTEGER,
    funds_json  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, broker)
  );
  `,
  // Which broker places this account's orders: its own (Dhan) or a linked, verified StoxKart (Dhan keeps the data).
  `ALTER TABLE broker_accounts ADD COLUMN trade_via TEXT NOT NULL DEFAULT 'own' CHECK (trade_via IN ('own', 'stoxkart'));`,
  // The settings and P&L rows of the trading broker not in use (see broker/per-broker.js), one JSON blob per kind.
  `
  CREATE TABLE broker_stash (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    data     TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, broker, kind)
  );
  `,
  // Each user's own static IP for the broker whitelist (see broker/static-ip.js).
  `
  CREATE TABLE static_ips (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ip          TEXT NOT NULL UNIQUE,
    family      INTEGER NOT NULL CHECK (family IN (4, 6)),
    assigned_at INTEGER NOT NULL
  );
  `,
  // Backtest: the user's own saved strategies ("My strategies"), replayed on the stored history (backtest/custom.js).
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_custom;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5', 'gap', 'custom')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_custom;
  DROP TABLE backtest_runs_before_custom;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Algo Trading: EMA 9/15 5m with a 30° EMA 9 angle, its own switch (off until switched on).
  `ALTER TABLE broker_accounts ADD COLUMN ema915_on INTEGER NOT NULL DEFAULT 0;`,
  // Backtest: the EMA 9/15 5m strategy ('ema915') on the stored history.
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_ema915;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5', 'gap', 'custom', 'ema915')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_ema915;
  DROP TABLE backtest_runs_before_ema915;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Risk rules in two sets: `config` = Manual trading, `algo_config` = Algo Trading (active while Algo Trading is on).
  // Starts as a copy of the current rules.
  `
  ALTER TABLE risk_rules ADD COLUMN algo_config TEXT;
  UPDATE risk_rules SET algo_config = config;
  `,
  // Kill switch when the Gap open 09:15 strategy has no entry that day (on by default).
  `ALTER TABLE broker_accounts ADD COLUMN gap_lock INTEGER NOT NULL DEFAULT 1;`,
  // Paper trading: strategies run on live prices with simulated fills, no orders (Gap retest 09:15 first).
  `
  ALTER TABLE broker_accounts ADD COLUMN retest_paper_on INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE broker_accounts ADD COLUMN retest_cfg TEXT;
  CREATE TABLE paper_trades (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    strategy TEXT NOT NULL,
    direction TEXT, symbol TEXT, security_id TEXT, exchange_segment TEXT,
    lots INTEGER, qty INTEGER,
    level REAL, entry_price REAL, sl_price REAL, exit_price REAL, pnl REAL, charges REAL,
    status TEXT NOT NULL CHECK (status IN ('watching', 'open', 'closed', 'skipped')),
    reason TEXT, detail TEXT,
    created_at INTEGER NOT NULL, entered_at INTEGER, closed_at INTEGER,
    UNIQUE (user_id, day, strategy)
  );
  CREATE INDEX paper_trades_user ON paper_trades(user_id, day DESC);
  `,
  // Paper mode for Algo Trading (AI Algo Trading: Real | Paper): the paper broker's wallet, orders and fills.
  `
  ALTER TABLE broker_accounts ADD COLUMN paper_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE auto_trades ADD COLUMN paper INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE paper_wallet (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance REAL NOT NULL, start_balance REAL NOT NULL, sod_day TEXT, sod_balance REAL, ks_day TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE paper_orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, security_id TEXT NOT NULL, segment TEXT NOT NULL, symbol TEXT,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')), type TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0),
    trigger_price REAL, limit_price REAL, ref_price REAL, avg_price REAL, filled_qty INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')), reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX paper_orders_user ON paper_orders(user_id, day, status);
  CREATE TABLE paper_fills (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, order_id INTEGER NOT NULL, security_id TEXT NOT NULL, segment TEXT NOT NULL, symbol TEXT,
    side TEXT NOT NULL, qty INTEGER NOT NULL, price REAL NOT NULL, charges REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX paper_fills_user ON paper_fills(user_id, day);
  `,
  // Gap open 09:15: its automatic 09:16 exit can be switched off (then the stop-loss, a manual exit or the cutoff).
  `ALTER TABLE broker_accounts ADD COLUMN gap_auto_exit INTEGER NOT NULL DEFAULT 1;`,
  // Backtest: "CE + PE at a target price" ('strangle') on the stored history.
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_strangle;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5', 'gap', 'custom', 'ema915', 'strangle')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_strangle;
  DROP TABLE backtest_runs_before_strangle;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Algo Trading: CE + PE at a target price (both sides daily), its own switch (off until switched on) and settings (JSON).
  `ALTER TABLE broker_accounts ADD COLUMN strangle_on INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE broker_accounts ADD COLUMN strangle_cfg TEXT;`,
  // Backtest: "Overnight ATM CE + PE" ('overnight') on the stored history.
  `
  DROP INDEX IF EXISTS backtest_runs_user;
  ALTER TABLE backtest_runs RENAME TO backtest_runs_before_overnight;
  CREATE TABLE backtest_runs (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy        TEXT NOT NULL CHECK (strategy IN ('openingRange', 'previousDay', 'ema45', 'orb5', 'gap', 'custom', 'ema915', 'strangle', 'overnight')),
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    horizon_bars    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    as_of           INTEGER NOT NULL,
    one_minute_bars INTEGER NOT NULL,
    range_sessions  INTEGER NOT NULL DEFAULT 0,
    signal_count    INTEGER NOT NULL,
    metrics_json    TEXT NOT NULL,
    candles_gzip    BLOB NOT NULL,
    exit_logic      TEXT NOT NULL DEFAULT 'horizon' CHECK (exit_logic IN ('horizon', 'emaZone', 'swingSL', 'levelReject')),
    stop_logic      TEXT NOT NULL DEFAULT 'none' CHECK (stop_logic IN ('none', 'breakoutCandle'))
  );
  INSERT INTO backtest_runs (id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic)
    SELECT id,user_id,strategy,start_date,end_date,horizon_bars,created_at,as_of,one_minute_bars,range_sessions,signal_count,metrics_json,candles_gzip,exit_logic,stop_logic
    FROM backtest_runs_before_overnight;
  DROP TABLE backtest_runs_before_overnight;
  CREATE INDEX backtest_runs_user ON backtest_runs(user_id, id DESC);
  `,
  // Algo Trading grid: each strategy on or off per index, with its settings (JSON; null = from the older switches).
  `ALTER TABLE broker_accounts ADD COLUMN algo_grid TEXT;`,
];
