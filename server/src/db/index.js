import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { MIGRATIONS } from './schema.js';

function open() {
  if (config.dbPath !== ':memory:') mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');

  // The app and the token keeper open the same database at start-up. Each step takes the write lock
  // first (BEGIN IMMEDIATE) and re-reads the version under it, so two processes never run one step twice.
  const step = db.transaction(() => {
    const version = db.pragma('user_version', { simple: true });
    if (version >= MIGRATIONS.length) return false;
    db.exec(MIGRATIONS[version]);
    db.pragma(`user_version = ${version + 1}`);
    return true;
  });
  while (step.immediate()) { /* next migration */ }
  return db;
}

export const db = open();

/** Wrap a function in a transaction; returns the wrapped function. */
export const tx = fn => db.transaction(fn);

// Write-behind for high-frequency, non-critical rows (live P&L): queued writes from the same moment
// are committed together in one transaction on the next turn of the event loop, instead of one
// commit each. Readers in this process use in-memory state, so nothing waits on them.
let queue = [];
const flush = tx(batch => { for (const fn of batch) fn(); });
export function deferWrite(fn) {
  if (!queue.length) setImmediate(() => { const batch = queue; queue = []; flush(batch); });
  queue.push(fn);
}
export const flushWrites = () => { const batch = queue; queue = []; if (batch.length) flush(batch); };

// Prepared statements are compiled once and reused.
const cache = new Map();
export function stmt(sql) {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}
