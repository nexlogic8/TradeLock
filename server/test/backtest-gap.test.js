// Gap open 09:15 backtest on a small synthetic history: signal from the ATM premiums (gap up + green, exactly one
// side), size from the capital, stop from the daily stop-loss % ÷ quantity, exit after the first opposite-colour
// NIFTY candle, and the two bounds (fill at the 09:15 open vs the 09:16 open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { gapBacktest, gapCoverage } from '../src/modules/backtest/gap.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const D1 = '2026-03-02', D2 = '2026-03-03', D3 = '2026-03-04';
const bar = (day, hhmm, o, h, l, c, extra = {}) => ({ time: t(day, hhmm), open: o, high: h, low: l, close: c, ...extra });

function store() {
  const s = openHistory(':memory:');
  s.saveIndex('NIFTY', D1, D3, [
    bar(D1, '15:29', 22480, 22510, 22470, 22500),
    // D2: green, green, red at 09:17 → a CE exits at the 09:18 open
    bar(D2, '09:15', 22520, 22560, 22515, 22550), bar(D2, '09:16', 22550, 22580, 22545, 22575), bar(D2, '09:17', 22575, 22578, 22540, 22545), bar(D2, '09:18', 22545, 22550, 22530, 22540),
    bar(D3, '09:15', 22400, 22420, 22380, 22390), bar(D3, '09:16', 22390, 22400, 22370, 22380),
  ]);
  const opt = (side, rows) => s.saveOptions('NIFTY', 1, side, 0, D1, D3, rows.map(r => ({ strike: 22500, ...r })));
  opt('CE', [bar(D1, '15:29', 98, 101, 97, 100),
    bar(D2, '09:15', 110, 116, 109, 115), bar(D2, '09:16', 115, 120, 114, 119), bar(D2, '09:17', 119, 121, 117, 118), bar(D2, '09:18', 118, 119, 116, 117),
    bar(D3, '09:15', 80, 82, 78, 79), bar(D3, '09:16', 79, 80, 77, 78)]);
  opt('PE', [bar(D1, '15:29', 118, 121, 117, 120),
    bar(D2, '09:15', 110, 111, 104, 105), bar(D2, '09:16', 105, 106, 102, 103), bar(D2, '09:17', 103, 108, 102, 107), bar(D2, '09:18', 107, 108, 105, 106),
    bar(D3, '09:15', 100, 104, 99, 103), bar(D3, '09:16', 103, 104, 101, 102)]);
  // D2 (Tue 3 Mar 2026) is an expiry day: D3's nearest-expiry contract (10 Mar) was D2's next expiry, slot 2.
  const next = (side, close) => s.saveOptions('NIFTY', 2, side, 0, D2, D2, [bar(D2, '15:29', close, close, close, close, { strike: 22500 })]);
  next('CE', 95); next('PE', 110);
  return s;
}

test('the one premium that gapped up green is bought; both bounds sized, stopped and exited as live', () => {
  const s = store();
  assert.deepEqual(gapCoverage(s), { from: D1, to: D3 });
  const r = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D3, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 1, exitCandle: '1m' }, s);
  assert.equal(r.sessions, 2);
  assert.equal(r.signals, 1, 'D2 CE only: 100 → 110 open, green; PE opened below its 120 close');
  const [best] = r.best.trades, [worst] = r.worst.trades;
  // best: 110 + ₹1 = 111; 90% of ₹1L / (111 × 65) = 12 lots; stop = 111 − ₹20,000 / 780, rounded up to a tick
  assert.deepEqual([best.side, best.entry, best.lots, best.qty, best.stop, best.exit], ['CE', 111, 12, 780, 85.4, 118]);
  assert.match(best.exitReason, /First red 1-min candle 09:17/);
  // worst: the 09:16 open 115 + ₹1 = 116; 11 lots; exits on the same red candle
  assert.deepEqual([worst.entry, worst.lots, worst.exit], [116, 11, 118]);
  assert.ok(best.net > worst.net && worst.net > 0);
  assert.equal(r.best.summary.endCapital, 100000 + best.net);
  const d3 = r.days.find(d => d.day === D3);
  assert.equal(d3.side, null);
  assert.match(d3.reason, /no premium gapped up/, 'D3 (after the 3 Mar expiry): CE 80 and PE 100 opened below the 10 Mar contracts (closes 95 / 110)');
  assert.deepEqual([d3.ce.prev, d3.pe.prev], [95, 110], 'previous close from slot 2 (the contract that is slot 1 on D3)');
  s.close();
});

test('a stop under 1% of the premium is no trade; a lot cap limits the size', () => {
  const s = store();
  const tight = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, dailySlPct: 0.5, exitCandle: '1m' }, s);
  assert.equal(tight.best.trades.length, 0);
  assert.equal(tight.best.skipped[0].reason, 'stop too tight', '₹500 ÷ 780 = ₹0.64 < 1% of 111');
  const capped = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, lotCap: 5, exitCandle: '1m' }, s);
  assert.equal(capped.best.trades[0].lots, 5);
  s.close();
});

test('exit on the opposite 5-minute candle: a red 1-minute candle inside a green 5-minute one does not exit', () => {
  const s = openHistory(':memory:'), day = '2026-03-05', prev = '2026-03-04';
  // NIFTY: 09:15–09:19 green overall (09:17 red alone), 09:20–09:24 red → exit at the 09:25 open.
  const idx = [['09:15', 100, 102], ['09:16', 102, 104], ['09:17', 104, 103], ['09:18', 103, 105], ['09:19', 105, 106],
    ['09:20', 106, 105], ['09:21', 105, 104], ['09:22', 104, 104.5], ['09:23', 104.5, 103], ['09:24', 103, 102], ['09:25', 102, 101]];
  s.saveIndex('NIFTY', prev, day, [bar(prev, '15:29', 99, 99, 99, 99), ...idx.map(([h, o, c]) => bar(day, h, o, Math.max(o, c), Math.min(o, c), c))]);
  const ce = idx.map(([h], i) => bar(day, h, 110 + i, 112 + i, 109 + i, 111 + i));
  s.saveOptions('NIFTY', 1, 'CE', 0, prev, day, [bar(prev, '15:29', 100, 100, 100, 100), ...ce].map(r => ({ strike: 22500, ...r })));
  s.saveOptions('NIFTY', 1, 'PE', 0, prev, day, [bar(prev, '15:29', 120, 120, 120, 120), bar(day, '09:15', 110, 111, 104, 105)].map(r => ({ strike: 22500, ...r })));
  const one = gapBacktest({ lateEntryPct: 0, startDate: day, endDate: day, costToCostR: 0, exitCandle: '1m' }, s).best.trades[0];
  assert.match(one.exitReason, /First red 1-min candle 09:17/);
  const five = gapBacktest({ lateEntryPct: 0, startDate: day, endDate: day, costToCostR: 0, exitCandle: '5m' }, s).best.trades[0];
  assert.match(five.exitReason, /First red 5-min candle 09:20/);
  assert.deepEqual([five.exitAt, five.exit], [t(day, '09:25'), 120], 'next minute open after the 09:20–09:24 candle');
  s.close();
});

test('exit at 09:16, any colour: one minute after the entry (best 09:15 → 09:16 open, worst 09:16 → 09:17 open)', () => {
  const r = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 1, exitCandle: '0916' }, store());
  const [best] = r.best.trades, [worst] = r.worst.trades;
  assert.deepEqual([best.entry, best.exit, best.exitAt], [111, 115, t(D2, '09:16')]);
  assert.match(best.exitReason, /Fixed exit 09:16/);
  assert.deepEqual([worst.entry, worst.exit, worst.exitAt], [116, 119, t(D2, '09:17')]);
});

test('strike choice: the side comes from the ATM gap, the trade uses ITM1 (CE: one strike below the ATM)', () => {
  const s = store();
  s.saveOptions('NIFTY', 1, 'CE', -1, D2, D2, [bar(D2, '09:15', 140, 150, 139, 148), bar(D2, '09:16', 149, 151, 147, 150), bar(D2, '09:17', 150, 152, 148, 151)].map(r => ({ strike: 22450, ...r })));
  const r = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 1, exitCandle: '0916', strike: 1 }, s);
  const [best] = r.best.trades;
  assert.deepEqual([best.side, best.strike, best.entry, best.exit], ['CE', 22450, 141, 149], 'ITM1 22450: 140 + ₹1 → exit at its 09:16 open');
  const otm = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, exitCandle: '0916', strike: -2 }, store());
  assert.equal(otm.best.trades.length, 0);
  assert.equal(otm.best.skipped[0].reason, 'strike not in the stored history');
});

test('previous close: an expiry rollover without the right contract, or a close under ₹1, is not a gap', () => {
  const s = store();
  s.db.prepare('DELETE FROM option_1m WHERE expiry_code = 2').run();
  const d3 = gapBacktest({ lateEntryPct: 0, startDate: D3, endDate: D3, exitCandle: '1m' }, s).days.find(d => d.day === D3);
  assert.equal(d3.side, null);
  assert.equal(d3.reason, 'previous close not found (expiry rollover)');
  const t2 = store();
  t2.db.prepare("UPDATE option_1m SET close = 0.05 WHERE side = 'CE' AND time = ?").run(t(D1, '15:29'));
  const d2 = gapBacktest({ lateEntryPct: 0, startDate: D2, endDate: D2, exitCandle: '1m' }, t2).days.find(d => d.day === D2);
  assert.equal(d2.side, null, 'CE 0.05 → 110 is a wrong contract, not a gap up');
  assert.equal(d2.ce.prev, null);
});

test('late entry: the best case fills that % above the 09:15 open (default 5%, as live fills land in the 09:15 spike)', () => {
  const late = gapBacktest({ startDate: D2, endDate: D2, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 1, exitCandle: '0916' }, store());
  // 110 × 1.05 + ₹1 = 116.5; the worst case (09:16 open) is unchanged
  assert.deepEqual([late.settings.lateEntryPct, late.best.trades[0].entry, late.best.label], [5, 116.5, 'Late entry: fill 5% above the 09:15 open']);
  const two = gapBacktest({ lateEntryPct: 2, startDate: D2, endDate: D2, slippage: 1, exitCandle: '0916' }, store());
  assert.equal(two.best.trades[0].entry, 113.2, '110 × 1.02 + 1');
  assert.equal(two.worst.trades[0].entry, late.worst.trades[0].entry);
});

test('minimum NIFTY gap: below the threshold (points, up or down) is no trade; at or above it trades as before', () => {
  const s = store();
  const o = { lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, exitCandle: '1m' };
  const below = gapBacktest({ ...o, minGapPts: 30 }, s);
  assert.equal(below.best.trades.length, 0);
  const d2 = below.days.find(d => d.day === D2);
  assert.equal(d2.indexGap, 20, 'D2 opened 22520 against the 22500 close');
  assert.match(d2.reason, /NIFTY gap 20 pts, below the 30-point threshold/);
  assert.equal(gapBacktest({ ...o, minGapPts: 20 }, s).best.trades.length, 1, 'a 20-point gap meets a 20-point threshold');
  assert.equal(gapBacktest({ ...o, minGapPts: 0 }, s).best.trades.length, 1, '0 = any gap');
  s.close();
});

test('fixed sizing with a rupee amount: that much a trade (the % is not used); 0 = the %', () => {
  const s = store();
  const o = { lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, compound: false, fundsUse: 90, exitCandle: '1m' };
  const [t1] = gapBacktest({ ...o, tradeAmount: 30000 }, s).best.trades;
  assert.equal(t1.lots, 4, '₹30,000 ÷ (111 × 65) = 4 lots');
  assert.equal(gapBacktest({ ...o, tradeAmount: 0 }, s).best.trades[0].lots, 12, '0: 90% of ₹1L = 12 lots');
  assert.equal(gapBacktest({ ...o, tradeAmount: 500000 }, s).best.trades[0].lots, 13, 'never more than the account holds: ₹1L ÷ 7,215 = 13 lots');
  assert.equal(gapBacktest({ ...o, compound: true, tradeAmount: 30000 }, s).best.trades[0].lots, 12, 'compounding sizes by the %');
  s.close();
});

test('retest entry: a limit buy at the 09:15 open when the option comes back to it; small stop; no retest → no trade', () => {
  // D2 as in store(), but the CE dips back to its 09:15 open (110) at 09:16, to 104 (below a 5% stop), closing at 116.
  const s = openHistory(':memory:');
  s.saveIndex('NIFTY', D1, D2, [bar(D1, '15:29', 22480, 22510, 22470, 22500),
    bar(D2, '09:15', 22520, 22560, 22515, 22550), bar(D2, '09:16', 22550, 22580, 22545, 22575), bar(D2, '09:17', 22575, 22590, 22570, 22585), bar(D2, '09:18', 22585, 22590, 22580, 22588)]);
  const opt = (side, rows) => s.saveOptions('NIFTY', 1, side, 0, D1, D2, rows.map(r => ({ strike: 22500, ...r })));
  opt('CE', [bar(D1, '15:29', 98, 101, 97, 100), bar(D2, '09:15', 110, 125, 109, 124), bar(D2, '09:16', 122, 123, 104, 116), bar(D2, '09:17', 119, 126, 118, 125), bar(D2, '09:18', 125, 127, 124, 126)]);
  opt('PE', [bar(D1, '15:29', 118, 121, 117, 120), bar(D2, '09:15', 110, 111, 104, 105), bar(D2, '09:16', 105, 106, 102, 103), bar(D2, '09:17', 103, 104, 101, 102), bar(D2, '09:18', 102, 103, 100, 101)]);
  const o = { startDate: D2, endDate: D2, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 0, exitCandle: '0916', entryMode: 'retest', retestMin: 15, retestSlPct: 5 };
  const r = gapBacktest(o, s);
  const [best] = r.best.trades, [worst] = r.worst.trades;
  assert.deepEqual([best.entry, best.stop, best.exit], [110, 104.5, 119], 'filled at the 09:15 open, stop 5% below, out at the 09:17 open');
  assert.equal(new Date((best.entryAt + 19800) * 1000).toISOString().slice(11, 16), '09:16', 'filled in the minute that came back to 110');
  assert.deepEqual([worst.exit, worst.exitReason], [104.5, 'Stop-loss'], 'worst case: the 104 low in the fill minute counts');
  // Never came back to 110 within 1 minute? (09:16 is minute 1, so a 1-minute window still sees it.) The store() day never does.
  const none = gapBacktest({ ...o }, store());
  assert.equal(none.best.trades.length, 0);
  assert.match(none.best.skipped[0].reason, /no retest of the 09:15 open 110 within 15 min/);
  s.close();
});
