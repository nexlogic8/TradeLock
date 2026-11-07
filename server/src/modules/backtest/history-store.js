// Local history store for fast backtests: Dhan's expired-options 1-minute candles (by expiry slot and
// strike offset from ATM) and the index's own 1-minute candles, downloaded once by the history
// backfill worker and read back here in milliseconds.
//
// A separate SQLite file next to the app database (data/history.db), so the live database and its
// backups stay small; the data can always be downloaded again.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS option_1m (
  underlying TEXT NOT NULL,      -- NIFTY
  expiry_code INTEGER NOT NULL,  -- 1 = nearest weekly expiry that day, 2 = the one after
  side TEXT NOT NULL,            -- CE | PE
  offset INTEGER NOT NULL,       -- strike steps from ATM at that minute (-10 … +10)
  time INTEGER NOT NULL,         -- candle start, epoch seconds
  strike REAL NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL, oi REAL, iv REAL, spot REAL,
  PRIMARY KEY (underlying, expiry_code, side, offset, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS option_1m_time ON option_1m (underlying, expiry_code, time);
CREATE TABLE IF NOT EXISTS index_1m (
  underlying TEXT NOT NULL, time INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  PRIMARY KEY (underlying, time)
) WITHOUT ROWID;
-- Every strike of an index's live contracts, saved while they trade (Dhan has no expired data for strikes far from
-- the ATM): cheap far options for backtests. Keyed by the actual expiry date and strike.
CREATE TABLE IF NOT EXISTS option_far_1m (
  underlying TEXT NOT NULL, expiry TEXT NOT NULL, side TEXT NOT NULL, strike REAL NOT NULL, time INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL, oi REAL,
  PRIMARY KEY (underlying, expiry, side, strike, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS option_far_1m_time ON option_far_1m (underlying, time);
CREATE TABLE IF NOT EXISTS far_fetch_log (
  underlying TEXT NOT NULL, expiry TEXT NOT NULL, side TEXT NOT NULL, strike REAL NOT NULL,
  from_day TEXT NOT NULL, to_day TEXT NOT NULL, rows INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (underlying, expiry, side, strike, from_day, to_day)
) WITHOUT ROWID;
-- One row per downloaded request, so an interrupted backfill resumes where it stopped.
CREATE TABLE IF NOT EXISTS fetch_log (
  kind TEXT NOT NULL, underlying TEXT NOT NULL, expiry_code INTEGER NOT NULL, side TEXT NOT NULL, offset INTEGER NOT NULL,
  from_day TEXT NOT NULL, to_day TEXT NOT NULL, rows INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (kind, underlying, expiry_code, side, offset, from_day, to_day)
) WITHOUT ROWID;
`;

export function historyPath() {
  if (process.env.HISTORY_DB_PATH) return process.env.HISTORY_DB_PATH;
  return config.dbPath === ':memory:' ? ':memory:' : path.join(path.dirname(config.dbPath), 'history.db');
}

export function openHistory(file = historyPath()) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const h = new Database(file);
  h.pragma('journal_mode = WAL');
  h.pragma('synchronous = NORMAL');
  h.pragma('busy_timeout = 5000');
  h.exec(SCHEMA);
  const insOpt = h.prepare(`INSERT OR REPLACE INTO option_1m (underlying, expiry_code, side, offset, time, strike, open, high, low, close, volume, oi, iv, spot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insIdx = h.prepare('INSERT OR REPLACE INTO index_1m (underlying, time, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)');
  const insLog = h.prepare('INSERT OR REPLACE INTO fetch_log (kind, underlying, expiry_code, side, offset, from_day, to_day, rows, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const getLog = h.prepare('SELECT rows FROM fetch_log WHERE kind = ? AND underlying = ? AND expiry_code = ? AND side = ? AND offset = ? AND from_day = ? AND to_day = ?');
  const n = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    db: h,
    /** Store one rollingoption response (rows carry epoch-second times) and log the request as done. */
    saveOptions: h.transaction((underlying, expiryCode, side, offset, fromDay, toDay, rows) => {
      for (const r of rows) insOpt.run(underlying, expiryCode, side, offset, r.time, r.strike, r.open, r.high, r.low, r.close, n(r.volume), n(r.oi), n(r.iv), n(r.spot));
      insLog.run('option', underlying, expiryCode, side, offset, fromDay, toDay, rows.length, Date.now());
    }),
    /** Store index candles (epoch-second times) and log the request as done. */
    saveIndex: h.transaction((underlying, fromDay, toDay, rows) => {
      for (const r of rows) insIdx.run(underlying, r.time, r.open, r.high, r.low, r.close);
      insLog.run('index', underlying, 0, '', 0, fromDay, toDay, rows.length, Date.now());
    }),
    /** Store one contract's candles (all-strike store) for an expiry date; rows carry epoch-second times. */
    saveFar: h.transaction((underlying, expiry, side, strike, rows) => {
      const ins = h.prepare('INSERT OR REPLACE INTO option_far_1m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(underlying, expiry, side, strike, r.time, r.open, r.high, r.low, r.close, n(r.volume), n(r.oi));
    }),
    fetched: (kind, underlying, expiryCode, side, offset, fromDay, toDay) => !!getLog.get(kind, underlying, expiryCode, side, offset, fromDay, toDay),
    /** Option candles for [fromSec, toSec), oldest first: { side, offset, time, strike, open, high, low, close, volume, oi, iv, spot }. */
    options: (underlying, expiryCode, fromSec, toSec) => h.prepare(`SELECT side, offset, time, strike, open, high, low, close, volume, oi, iv, spot FROM option_1m
      WHERE underlying = ? AND expiry_code = ? AND time >= ? AND time < ? ORDER BY time`).all(underlying, expiryCode, fromSec, toSec),
    /** Index candles for [fromSec, toSec), oldest first. */
    index: (underlying, fromSec, toSec) => h.prepare('SELECT time, open, high, low, close FROM index_1m WHERE underlying = ? AND time >= ? AND time < ? ORDER BY time')
      .all(underlying, fromSec, toSec),
    /** Row counts and covered range, for a quick status line. */
    summary: () => ({
      options: h.prepare('SELECT underlying, expiry_code AS code, COUNT(*) AS rows, MIN(time) AS first, MAX(time) AS last FROM option_1m GROUP BY underlying, expiry_code').all(),
      index: h.prepare('SELECT underlying, COUNT(*) AS rows, MIN(time) AS first, MAX(time) AS last FROM index_1m GROUP BY underlying').all(),
      requests: h.prepare('SELECT COUNT(*) AS n FROM fetch_log').get().n,
    }),
    close: () => h.close(),
  };
}
