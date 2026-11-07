// "CE + PE at a target price" backtest on a small synthetic history: the call and the put nearest ₹3 at 09:20,
// a 20% stop on each one, the rest sold at 15:25; sizing, volume limit, charges and skipped days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { strangleBacktest } from '../src/modules/backtest/strangle.js';
import { lotSizeOn } from '../src/modules/scalper/option-backtest.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const D = '2026-03-04', EXP = '2026-03-03';   // a Wednesday; the Tuesday before is a NIFTY expiry day
const minutes = () => { const out = []; for (let m = 15; m < 390; m++) { const h = 9 + Math.floor(m / 60); out.push(`${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); } return out; };
const series = (day, strike, priceAt, volume = 1000) => minutes().map(hhmm => { const p = priceAt(hhmm); return { time: t(day, hhmm), strike, open: p.open ?? p.close, high: Math.max(p.open ?? p.close, p.close), low: p.low ?? Math.min(p.open ?? p.close, p.close), close: p.close, volume }; });

function store(days = [D]) {
  const s = openHistory(':memory:');
  for (const day of days) {
    s.saveIndex('NIFTY', day, day, minutes().map(hhmm => ({ time: t(day, hhmm), open: 22500, high: 22501, low: 22499, close: 22500 })));
    // CE 23500 at ₹3, climbing to ₹6 from 12:00; CE 23600 at ₹1.50 (outside the ₹2.10–3.90 band).
    s.saveOptions('NIFTY', 1, 'CE', 10, day, day, series(day, 23500, h => ({ close: h >= '12:00' ? 6 : 3 })));
    s.saveOptions('NIFTY', 1, 'CE', 9, day, day, series(day, 23600, () => ({ close: 1.5 })));
    // PE 21500 at ₹3.10, dipping to ₹2.20 at 11:00 (low under the ₹2.48 stop, opening above it) and ₹2.00 later.
    s.saveOptions('NIFTY', 1, 'PE', -10, day, day, series(day, 21500, h => (h === '11:00' ? { open: 2.9, low: 2.2, close: 2.3 } : { close: h > '11:00' ? 2 : 3.1 })));
  }
  return s;
}

test('buys the call and the put nearest the target, stops the falling one at −20%, sells the other at the exit time', () => {
  const r = strangleBacktest({ source: 'near', startDate: D, endDate: D, underlying: 'NIFTY', target: 3, stopMode: 'leg', stopPct: 20, capital: 100000, maxVolPct: 0 }, store());
  assert.equal(r.trades.length, 1);
  const [x] = r.trades, lot = lotSizeOn('NIFTY', D);
  assert.deepEqual([x.ce.strike, x.ce.entry, x.ce.entryAt, x.ce.exit, x.ce.exitAt, x.ce.exitReason], [23500, 3, t(D, '09:20'), 6, t(D, '15:25'), 'Exit 15:25']);
  assert.deepEqual([x.pe.strike, x.pe.entry, x.pe.stop, x.pe.exit, x.pe.exitAt, x.pe.exitReason], [21500, 3.1, 2.48, 2.48, t(D, '11:00'), 'Stop −20%']);
  assert.equal(x.lots, Math.floor(100000 / (6.1 * lot)));
  assert.equal(x.qty, x.lots * lot);
  assert.equal(x.gross, Math.round(((6 - 3) + (2.48 - 3.1)) * x.qty * 100) / 100);
  assert.equal(x.net, Math.round((x.gross - x.charges) * 100) / 100);
  assert.equal(r.summary.endCapital, Math.round((100000 + x.net) * 100) / 100);
  assert.equal(x.expiry, '2026-03-10');
});

test('no stop holds both to the exit; a stop on both together sells both at once', () => {
  const none = strangleBacktest({ source: 'near', startDate: D, endDate: D, target: 3, stopMode: 'none', capital: 100000, maxVolPct: 0 }, store()).trades[0];
  assert.deepEqual([none.ce.exit, none.pe.exit, none.pe.exitReason], [6, 2, 'Exit 15:25']);
  // Together 6.10 → 3 + 2.30 = 5.30 at 11:00 is −13%: a 10% stop on both sells both at that minute's close.
  const whole = strangleBacktest({ source: 'near', startDate: D, endDate: D, target: 3, stopMode: 'whole', stopPct: 10, capital: 100000, maxVolPct: 0 }, store()).trades[0];
  assert.deepEqual([whole.ce.exit, whole.pe.exit, whole.ce.exitAt, whole.ce.exitReason], [3, 2.3, t(D, '11:00'), 'Both sold: together −10%']);
});

test('the volume limit caps the lots; expiry days and days without a ₹3 pair are skipped with the reason', () => {
  const capped = strangleBacktest({ source: 'near', startDate: D, endDate: D, target: 3, capital: 1e7, maxVolPct: 10 }, store()).trades[0];
  // 09:15–09:20 (the session's first 6 minutes) × 1,000 traded on each side = 6,000; 10% = 600 units → whole lots.
  assert.equal(capped.lots, Math.floor(600 / lotSizeOn('NIFTY', D)));
  assert.equal(capped.volCapped, true);
  const r = strangleBacktest({ source: 'near', startDate: EXP, endDate: D, target: 3, maxVolPct: 0 }, store([EXP, D]));
  assert.deepEqual(r.skipped.map(x => [x.day, x.reason]), [[EXP, 'expiry day (the option expires today)']]);
  const far = strangleBacktest({ source: 'near', startDate: D, endDate: D, target: 50, maxVolPct: 0 }, store());
  assert.equal(far.trades.length, 0);
  assert.match(far.skipped[0].reason, /^no call or put traded at ₹35–65 between 09:20 and 09:45/);
});

test('compounding carries each day’s result into the next day’s size', () => {
  const D2 = '2026-03-05';
  const r = strangleBacktest({ source: 'near', startDate: D, endDate: D2, target: 3, stopMode: 'none', capital: 100000, maxVolPct: 0 }, store([D, D2]));
  assert.equal(r.trades.length, 2);
  const [a, b] = r.trades, lot = lotSizeOn('NIFTY', D2);
  assert.equal(b.lots, Math.floor(a.capitalAfter / (6.1 * lot)));
  assert.equal(r.summary.endCapital, b.capitalAfter);
  assert.equal(r.months.length, 1);
});

test('all-strike source: picks from every saved strike of the nearest saved contract, by its real expiry date', () => {
  const s = store([]), day = '2026-10-28';
  s.saveIndex('NIFTY', day, day, minutes().map(hhmm => ({ time: t(day, hhmm), open: 22600, high: 22601, low: 22599, close: 22600 })));
  const far = (side, strike, priceAt) => s.saveFar('NIFTY', '2026-11-09', side, strike, series(day, strike, priceAt));
  far('CE', 24600, h => ({ close: h >= '12:00' ? 2.05 : 2.95 }));
  far('CE', 25000, () => ({ close: 1 }));
  far('PE', 20050, () => ({ close: 3.6 }));
  s.saveFar('NIFTY', '2026-11-17', 'CE', 24000, series(day, 24000, () => ({ close: 3 })));   // a later contract: not used
  const r = strangleBacktest({ startDate: day, endDate: day, source: 'all', target: 3, stopMode: 'none', capital: 100000, maxVolPct: 0 }, s);
  const [x] = r.trades;
  assert.deepEqual([x.expiry, x.ce.strike, x.ce.entry, x.ce.exit, x.pe.strike, x.pe.entry, x.pe.exit], ['2026-11-09', 24600, 2.95, 2.05, 20050, 3.6, 3.6]);
  // A day before any saved contract's data: skipped with the reason.
  const none = strangleBacktest({ startDate: day, endDate: day, source: 'all', target: 3, expiryCode: 2 }, store([day]));
  assert.match(none.skipped[0].reason, /no stored contract|no stored option prices/);
});
