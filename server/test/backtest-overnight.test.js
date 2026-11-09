// "Overnight ATM CE + PE" backtest on a small synthetic history: buy the ATM call and put at 15:25, sell both at 09:45
// the next trading day; skipped nights before a weekend and before expiry; OTM1 strikes; sizing and charges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { overnightBacktest, OVERNIGHT_DEFAULTS } from '../src/modules/backtest/overnight.js';
import { lotSizeOn } from '../src/modules/scalper/option-backtest.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
// Wed 4 – Tue 10 Mar 2026; Tuesday 10 Mar is the NIFTY weekly expiry.
const DAYS = ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10'];
const minutes = () => { const out = []; for (let m = 15; m < 390; m++) { const h = 9 + Math.floor(m / 60); out.push(`${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); } return out; };
const series = (day, strike, priceAt) => minutes().map(hhmm => { const p = priceAt(hhmm); return { time: t(day, hhmm), strike, open: p, high: p, low: p, close: p, volume: 1000 }; });

// ATM call ₹100 and put ₹90 all day; the next morning the call is ₹160 and the put ₹60 from 09:30.
const morning = (day, base, after) => h => (day !== DAYS[0] && h >= '09:30' && h < '10:00' ? after : base);
function store() {
  const s = openHistory(':memory:');
  for (const day of DAYS) {
    s.saveIndex('NIFTY', day, day, minutes().map(hhmm => ({ time: t(day, hhmm), open: 22500, high: 22501, low: 22499, close: 22500 })));
    s.saveOptions('NIFTY', 1, 'CE', 0, day, day, series(day, 22500, morning(day, 100, 160)));
    s.saveOptions('NIFTY', 1, 'PE', 0, day, day, series(day, 22500, morning(day, 90, 60)));
    s.saveOptions('NIFTY', 1, 'CE', 1, day, day, series(day, 22550, morning(day, 70, 120)));
    s.saveOptions('NIFTY', 1, 'PE', -1, day, day, series(day, 22450, morning(day, 65, 40)));
  }
  return s;
}

test('defaults: ATM, buy 15:25, sell 09:45 next day, skip expiry eve and weekends, ₹50,000 compounding', () => {
  assert.deepEqual({ ...OVERNIGHT_DEFAULTS }, { strikes: 'atm', entryTime: '15:25', exitTime: '09:45', expiryEve: 'skip', skipBreaks: true, capital: 50000, fundsUse: 100, sizing: 'compound', slippage: 0 });
});

test('buys the ATM call and put at the 15:25 close and sells both at the 09:45 open the next day', () => {
  const r = overnightBacktest({ startDate: DAYS[0], endDate: DAYS[0], underlying: 'NIFTY' }, store());
  assert.equal(r.trades.length, 1);
  const [x] = r.trades, lot = lotSizeOn('NIFTY', DAYS[0]);
  assert.deepEqual([x.day, x.next, x.expiry], [DAYS[0], DAYS[1], '2026-03-10']);
  assert.deepEqual([x.ce.strike, x.ce.entry, x.ce.entryAt, x.ce.exit, x.ce.exitAt], [22500, 100, t(DAYS[0], '15:25'), 160, t(DAYS[1], '09:45')]);
  assert.deepEqual([x.pe.strike, x.pe.entry, x.pe.exit], [22500, 90, 60]);
  assert.equal(x.lots, Math.floor(50000 / (190 * lot)));
  assert.equal(x.gross, Math.round(((160 - 100) + (60 - 90)) * x.qty * 100) / 100);
  assert.equal(x.net, Math.round((x.gross - x.charges) * 100) / 100);
  assert.equal(r.summary.endCapital, Math.round((50000 + x.net) * 100) / 100);
});

test('skips the Friday → Monday night and the night before expiry; holds them when asked', () => {
  const skip = overnightBacktest({ startDate: DAYS[2], endDate: DAYS[3], underlying: 'NIFTY' }, store());
  assert.equal(skip.trades.length, 0);
  assert.match(skip.skipped[0].reason, /weekend or holiday/);
  assert.match(skip.skipped[1].reason, /expires on 2026-03-10/);
  const hold = overnightBacktest({ startDate: DAYS[2], endDate: DAYS[3], underlying: 'NIFTY', skipBreaks: false, expiryEve: 'hold' }, store());
  assert.deepEqual(hold.trades.map(x => [x.day, x.next, x.expiry]), [[DAYS[2], DAYS[3], '2026-03-10'], [DAYS[3], DAYS[4], '2026-03-10']]);
});

test('one strike out of the money on each side; fixed sizing uses the starting capital', () => {
  const r = overnightBacktest({ startDate: DAYS[0], endDate: DAYS[1], underlying: 'NIFTY', strikes: 'otm1', sizing: 'fixed', capital: 100000 }, store());
  const [x] = r.trades, lot = lotSizeOn('NIFTY', DAYS[0]);
  assert.deepEqual([x.ce.strike, x.ce.entry, x.ce.exit, x.pe.strike, x.pe.entry, x.pe.exit], [22550, 70, 120, 22450, 65, 40]);
  assert.equal(x.lots, Math.floor(100000 / (135 * lot)));
  assert.equal(r.trades[1].lots, x.lots, 'fixed: the same size the next night');
});

test('a special weekend session (Diwali Muhurat) is not a night of its own: Friday → Monday is a weekend', () => {
  const s = store(), FRI = '2026-11-06', SUN = '2026-11-08', MON = '2026-11-09', TUE = '2026-11-10';
  for (const day of [FRI, SUN, MON, TUE]) {
    s.saveIndex('NIFTY', day, day, minutes().map(hhmm => ({ time: t(day, hhmm), open: 22500, high: 22501, low: 22499, close: 22500 })));
    if (day !== SUN) for (const [side, k] of [['CE', 22500], ['PE', 22500]]) s.saveOptions('NIFTY', 1, side, 0, day, day, series(day, k, () => 100));
  }
  const r = overnightBacktest({ startDate: FRI, endDate: SUN, underlying: 'NIFTY' }, s);
  assert.deepEqual(r.skipped.map(x => x.day), [FRI]);
  assert.match(r.skipped[0].reason, new RegExp(`next session is ${MON}`));
  const held = overnightBacktest({ startDate: FRI, endDate: SUN, underlying: 'NIFTY', skipBreaks: false, expiryEve: 'hold' }, s);   // Friday is the eve of the 9 Nov expiry
  assert.deepEqual(held.trades.map(x => [x.day, x.next]), [[FRI, MON]]);
});

test('an expiry on an exchange holiday moves back a day, even past the last stored day (10 Nov 2026 → 9 Nov)', () => {
  const s = store(), FRI = '2026-11-06', MON = '2026-11-09';
  for (const day of [FRI, MON]) {
    s.saveIndex('NIFTY', day, day, minutes().map(hhmm => ({ time: t(day, hhmm), open: 22500, high: 22501, low: 22499, close: 22500 })));
    for (const side of ['CE', 'PE']) { s.saveOptions('NIFTY', 1, side, 0, day, day, series(day, 22500, () => 100)); s.saveOptions('NIFTY', 2, side, 0, day, day, series(day, 22500, () => 200)); }
  }
  const skip = overnightBacktest({ startDate: FRI, endDate: FRI, underlying: 'NIFTY', skipBreaks: false }, s);
  assert.match(skip.skipped[0].reason, /expires on 2026-11-09/);
  const next = overnightBacktest({ startDate: FRI, endDate: FRI, underlying: 'NIFTY', skipBreaks: false, expiryEve: 'next' }, s);
  assert.deepEqual([next.trades[0].expiry, next.trades[0].ce.entry], ['2026-11-17', 200]);
});
