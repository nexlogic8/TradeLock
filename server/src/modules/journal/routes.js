// Trading journal: the trader's own notes per day. Create, read, update, delete; owner-only.
import { stmt } from '../../db/index.js';
import { v } from '../../lib/validate.js';
import { bad, notFound } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { ist } from '../../lib/time.js';
import { fillsForDay } from '../trades/service.js';
import { dayState } from '../risk/service.js';

export const MOODS = ['great', 'good', 'neutral', 'bad', 'tilt'];
const MAX_ENTRIES = 5000;

const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
  && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/** Validate and normalise an entry from the request body. */
export function normalizeEntry(b = {}) {
  const day = b.day ?? ist().day;
  if (!validDay(day) || day > ist().day) throw bad('VALIDATION', 'Choose a valid date, today or earlier.', { field: 'day' });
  const optional = (x, fn) => (x === null || x === undefined || x === '' ? null : fn(x));
  const tags = Array.isArray(b.tags) ? b.tags : typeof b.tags === 'string' ? b.tags.split(',') : [];
  const cleanTags = [...new Set(tags.map(t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean))];
  if (cleanTags.length > 8 || cleanTags.some(t => t.length > 24)) throw bad('VALIDATION', 'Use up to 8 tags of at most 24 characters.', { field: 'tags' });
  return {
    day,
    title: v.str(b.title ?? '', 'Title', { min: 1, max: 120 }),
    body: v.str(b.body ?? '', 'Notes', { max: 10_000 }),
    mood: optional(b.mood, x => v.oneOf(x, 'Mood', MOODS)),
    discipline: optional(b.discipline, x => v.num(Number(x), 'Discipline', { min: 1, max: 5, int: true })),
    symbol: v.str(b.symbol ?? '', 'Symbol', { max: 40 }).toUpperCase(),
    pnl: optional(b.pnl, x => Math.round(v.num(x, 'P&L', { min: -1e8, max: 1e8 }) * 100) / 100),
    tags: cleanTags,
  };
}

const publicEntry = row => row && ({
  id: row.id, day: row.day, title: row.title, body: row.body, mood: row.mood, discipline: row.discipline,
  symbol: row.symbol, pnl: row.pnl, tags: JSON.parse(row.tags || '[]'), createdAt: row.created_at, updatedAt: row.updated_at,
});

function owned(userId, id) {
  const row = stmt('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);
  if (!row) throw notFound('Journal entry not found.');
  return row;
}

/** Days journaled in a row, ending today or yesterday. */
function streak(days, today) {
  const set = new Set(days);
  const d = new Date(`${today}T00:00:00Z`);
  if (!set.has(today)) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (set.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}

// ---- Auto-fill from the day's broker trades -------------------------------------------------------
export const AUTO_START = '— Trades (auto-filled from your broker) —';
const AUTO_END = '— end of auto-fill —';
const hm = ts => new Date(ts + 19_800_000).toISOString().slice(11, 16);
const rupees = n => `${n < 0 ? '−' : n > 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "NIFTY-Oct2026-22950-PE" → "NIFTY 22950 PE". */
export const prettySymbol = sym => {
  const m = String(sym).match(/^([A-Z]+)-[A-Za-z]{3}\d{4}-(\d+(?:\.\d+)?)-(CE|PE)$/);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : String(sym);
};
const RULE_TAGS = { maxLoss: 'loss-limit', maxTrades: 'trade-cap', profitLock: 'profit-target', cutoff: 'cutoff', lossStreak: 'loss-streak', giveback: 'giveback' };

/** Round trips from the day's fills: each runs from flat to flat (or is still open at the end). */
export function roundTrips(fills) {
  const open = new Map(), out = [];
  for (const f of fills) {
    const d = f.side === 'BUY' ? f.qty : -f.qty;
    let t = open.get(f.symbol);
    if (!t) { t = { symbol: f.symbol, side: d > 0 ? 'BUY' : 'SELL', openedAt: f.ts, qty: 0, pos: 0, inQty: 0, inValue: 0, outQty: 0, outValue: 0 }; open.set(f.symbol, t); }
    const adding = t.pos === 0 || Math.sign(d) === Math.sign(t.pos);
    if (adding) { t.inQty += f.qty; t.inValue += f.qty * f.price; t.pos += d; t.qty = Math.max(t.qty, Math.abs(t.pos)); continue; }
    const closing = Math.min(f.qty, Math.abs(t.pos));
    t.outQty += closing; t.outValue += closing * f.price; t.pos += Math.sign(d) * closing; t.closedAt = f.ts;
    if (t.pos === 0) {
      const entry = t.inValue / t.inQty, exit = t.outValue / t.outQty;
      out.push({ symbol: t.symbol, side: t.side, qty: t.qty, entry, exit, openedAt: t.openedAt, closedAt: t.closedAt,
        pnl: Math.round((t.side === 'BUY' ? exit - entry : entry - exit) * t.outQty * 100) / 100 });
      open.delete(f.symbol);
      const rest = f.qty - closing;   // a reversal opens the next trade with the remainder
      if (rest > 0) open.set(f.symbol, { symbol: f.symbol, side: f.side, openedAt: f.ts, qty: rest, pos: Math.sign(d) * rest, inQty: rest, inValue: rest * f.price, outQty: 0, outValue: 0 });
    }
  }
  for (const t of open.values()) out.push({ symbol: t.symbol, side: t.side, qty: Math.abs(t.pos), entry: t.inValue / t.inQty, openedAt: t.openedAt, open: true });
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

/** Whole symbols that fit the 40-character field, then "+N" for the rest. */
function fitSymbols(list) {
  const fit = [];
  for (const sym of list) if ([...fit, sym].join(', ').length <= (fit.length + 1 < list.length ? 36 : 40)) fit.push(sym); else break;
  const rest = list.length - fit.length;
  return `${fit.join(', ')}${rest ? ` +${rest}` : ''}`;
}

/** Entry fields filled from a day's trades, risk events and P&L. */
export function autofill(userId, day) {
  const trips = roundTrips(fillsForDay(userId, day));
  const events = stmt(`SELECT symbol, note FROM trades WHERE user_id = ? AND day = ? AND kind = 'event' AND side = 'LIMIT' ORDER BY ts`).all(userId, day);
  const s = dayState(userId, day);
  const pnl = Math.round((Number(s.realized) + Number(s.unrealized)) * 100) / 100;
  const closed = trips.filter(t => !t.open), wins = closed.filter(t => t.pnl > 0).length, losses = closed.filter(t => t.pnl < 0).length;
  if (!trips.length) return { day, trades: 0, title: '', symbol: '', pnl: null, tags: [], block: '' };
  const symbols = [...new Set(trips.map(t => prettySymbol(t.symbol)))];
  const underlyings = [...new Set(trips.map(t => prettySymbol(t.symbol).split(' ')[0].toLowerCase()))];
  const ruleTags = [...new Set(s.fired.filter(f => f.endsWith('.breach')).map(f => RULE_TAGS[f.split('.')[0]]).filter(Boolean))];
  const lines = trips.map((t, i) => t.open
    ? `${i + 1}. ${hm(t.openedAt)} → open   ${prettySymbol(t.symbol)}  ${t.side} ${t.qty} @ ${price(t.entry)}  (still open)`
    : `${i + 1}. ${hm(t.openedAt)} → ${hm(t.closedAt)}  ${prettySymbol(t.symbol)}  ${t.side} ${t.qty} @ ${price(t.entry)} → ${price(t.exit)}  ${rupees(t.pnl)}`);
  const block = [AUTO_START, ...lines,
    ...(events.length ? ['', 'Risk events:', ...events.map(e => `• ${e.symbol}${e.note ? ` — ${e.note}` : ''}`)] : []),
    '', `Day P&L: ${rupees(pnl)} · ${trips.length} trade${trips.length === 1 ? '' : 's'} · ${wins} won, ${losses} lost`, AUTO_END].join('\n');
  return {
    day, trades: trips.length,
    title: `${trips.length} trade${trips.length === 1 ? '' : 's'} · ${wins}W ${losses}L · ${rupees(Math.round(pnl))}`.replace('.00', ''),
    symbol: fitSymbols(symbols),
    pnl,
    tags: [...underlyings, pnl > 0 ? 'green-day' : pnl < 0 ? 'red-day' : 'flat-day', ...ruleTags].slice(0, 8),
    block,
  };
}

export function journalRoutes(r) {
  r.get('/api/journal/autofill', ctx => {
    const day = ctx.query.day || ist().day;
    if (!validDay(day) || day > ist().day) throw bad('VALIDATION', 'Choose a valid date, today or earlier.', { field: 'day' });
    return autofill(ctx.user.id, day);
  });

  r.get('/api/journal', ctx => {
    const rows = stmt('SELECT * FROM journal_entries WHERE user_id = ? ORDER BY day DESC, id DESC').all(ctx.user.id);
    const entries = rows.map(publicEntry);
    const today = ist().day, month = today.slice(0, 7);
    const rated = entries.filter(e => e.discipline);
    return {
      entries,
      stats: {
        total: entries.length,
        thisMonth: entries.filter(e => e.day.startsWith(month)).length,
        streak: streak(entries.map(e => e.day), today),
        discipline: rated.length ? Math.round(rated.reduce((s, e) => s + e.discipline, 0) / rated.length * 10) / 10 : null,
      },
      today,
    };
  });

  r.post('/api/journal', ctx => {
    limit(`journal-write:${ctx.user.id}`, 60, 60_000);
    const count = stmt('SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ?').get(ctx.user.id).n;
    if (count >= MAX_ENTRIES) throw bad('JOURNAL_FULL', `The journal holds up to ${MAX_ENTRIES.toLocaleString('en-IN')} entries. Delete old ones to add more.`);
    const e = normalizeEntry(ctx.body), now = Date.now();
    const { lastInsertRowid } = stmt(`INSERT INTO journal_entries (user_id, day, title, body, mood, discipline, symbol, pnl, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ctx.user.id, e.day, e.title, e.body, e.mood, e.discipline, e.symbol, e.pnl, JSON.stringify(e.tags), now, now);
    return { entry: publicEntry(owned(ctx.user.id, lastInsertRowid)) };
  });

  r.put('/api/journal/:id', ctx => {
    limit(`journal-write:${ctx.user.id}`, 60, 60_000);
    const row = owned(ctx.user.id, ctx.params.id);
    const e = normalizeEntry(ctx.body);
    stmt(`UPDATE journal_entries SET day = ?, title = ?, body = ?, mood = ?, discipline = ?, symbol = ?, pnl = ?, tags = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`).run(e.day, e.title, e.body, e.mood, e.discipline, e.symbol, e.pnl, JSON.stringify(e.tags), Date.now(), row.id, ctx.user.id);
    return { entry: publicEntry(owned(ctx.user.id, row.id)) };
  });

  r.delete('/api/journal/:id', ctx => {
    limit(`journal-write:${ctx.user.id}`, 60, 60_000);
    const row = owned(ctx.user.id, ctx.params.id);
    stmt('DELETE FROM journal_entries WHERE id = ? AND user_id = ?').run(row.id, ctx.user.id);
    return { ok: true, id: row.id };
  });
}
