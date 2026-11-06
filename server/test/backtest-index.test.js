// Backtests on BANK NIFTY and SENSEX: lot sizes and expiry calendars by index, and the Gap open 09:15 backtest
// reading the chosen index's stored history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHistory } from '../src/modules/backtest/history-store.js';
import { gapBacktest, gapCoverage } from '../src/modules/backtest/gap.js';
import { indexExpiry, lotSizeOn, niftyLotSize } from '../src/modules/scalper/option-backtest.js';

const t = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const bar = (day, hhmm, o, h, l, c, extra = {}) => ({ time: t(day, hhmm), open: o, high: h, low: l, close: c, ...extra });

test('lot sizes by index and date', () => {
  assert.equal(lotSizeOn('NIFTY', '2026-11-05'), niftyLotSize('2026-11-05'));
  assert.equal(lotSizeOn('NIFTY', '2026-11-05'), 65);
  assert.equal(lotSizeOn('BANKNIFTY', '2026-11-05'), 30);
  assert.equal(lotSizeOn('BANKNIFTY', '2025-06-10'), 35);
  assert.equal(lotSizeOn('BANKNIFTY', '2024-06-10'), 15);
  assert.equal(lotSizeOn('SENSEX', '2026-11-05'), 20);
  assert.equal(lotSizeOn('SENSEX', '2024-06-10'), 10);
});

test('expiry calendars: SENSEX weekly (Fri → Tue → Thu), BANK NIFTY monthly, NIFTY unchanged', () => {
  const e = (u, d, n = 1) => indexExpiry(u, d, n).date;
  assert.equal(e('NIFTY', '2026-11-05'), '2026-11-10');
  assert.equal(e('SENSEX', '2026-11-05'), '2026-11-05', 'Thursday from Sep 2025');
  assert.equal(e('SENSEX', '2026-11-06', 2), '2026-11-19');
  assert.equal(e('SENSEX', '2025-06-10'), '2025-06-10', 'Tuesday Jan–Aug 2025');
  assert.equal(e('SENSEX', '2024-06-12'), '2024-06-14', 'Friday before 2025');
  assert.equal(e('BANKNIFTY', '2026-11-05'), '2026-11-24', 'last Tuesday of the month');
  assert.equal(e('BANKNIFTY', '2026-11-05', 2), '2026-12-29');
  assert.equal(e('BANKNIFTY', '2026-11-25'), '2026-12-29', 'after this month’s expiry: next month');
  assert.equal(e('BANKNIFTY', '2024-06-10'), '2024-06-26', 'last Wednesday Mar–Dec 2024');
  assert.equal(e('BANKNIFTY', '2025-02-03'), '2025-02-27', 'last Thursday Jan–Aug 2025');
  // A holiday on the expiry moves it to the trading day before.
  const days = new Set(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-25']);
  assert.equal(indexExpiry('BANKNIFTY', '2026-11-19', 1, days).date, '2026-11-23');
});

test('Gap backtest on BANK NIFTY reads its own history and sizes in its lots', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  s.saveIndex('BANKNIFTY', D1, D2, [bar(D1, '15:29', 51000, 51020, 50980, 51000),
    bar(D2, '09:15', 51200, 51300, 51190, 51280), bar(D2, '09:16', 51280, 51290, 51200, 51210), bar(D2, '09:17', 51210, 51220, 51150, 51160)]);
  const opt = (side, rows) => s.saveOptions('BANKNIFTY', 1, side, 0, D1, D2, rows.map(r => ({ strike: 51000, ...r })));
  opt('CE', [bar(D1, '15:29', 300, 305, 295, 300), bar(D2, '09:15', 330, 345, 328, 340), bar(D2, '09:16', 340, 342, 330, 332), bar(D2, '09:17', 332, 333, 320, 322)]);
  opt('PE', [bar(D1, '15:29', 320, 325, 315, 320), bar(D2, '09:15', 300, 302, 290, 292), bar(D2, '09:16', 292, 300, 291, 299), bar(D2, '09:17', 299, 305, 298, 304)]);
  assert.equal(gapCoverage(s), null, 'no NIFTY history in this store');
  assert.deepEqual(gapCoverage(s, 'BANKNIFTY'), { from: D1, to: D2 });
  assert.equal(gapCoverage(s, 'SENSEX'), null);

  const r = gapBacktest({ underlying: 'BANKNIFTY', lateEntryPct: 0, startDate: D2, endDate: D2, capital: 100000, dailySlPct: 20, fundsUse: 90, slippage: 1, exitCandle: '0916', costToCostR: 0 }, s);
  assert.equal(r.signals, 1, 'CE opened above its previous close (300 → 330) and closed green; same monthly contract, slot 1');
  const [tr] = r.best.trades;
  // 330 + ₹1 = 331; 90% of ₹1L / (331 × 30) = 9 lots of 30 = 270
  assert.deepEqual([tr.side, tr.entry, tr.lotSize, tr.lots, tr.qty, tr.exit], ['CE', 331, 30, 9, 270, 340]);
  assert.equal(r.settings.underlying, 'BANKNIFTY');
  // The same store run on NIFTY finds no sessions.
  assert.equal(gapBacktest({ startDate: D2, endDate: D2 }, s).sessions, 0);
  s.close();
});

test('Gap backtest on SENSEX: 20 a lot, and the gap threshold names the index', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  s.saveIndex('SENSEX', D1, D2, [bar(D1, '15:29', 80000, 80000, 80000, 80000), bar(D2, '09:15', 80300, 80400, 80290, 80380), bar(D2, '09:16', 80380, 80390, 80300, 80310)]);
  const opt = (side, rows) => s.saveOptions('SENSEX', 1, side, 0, D1, D2, rows.map(r => ({ strike: 80000, ...r })));
  opt('CE', [bar(D1, '15:29', 400, 400, 400, 400), bar(D2, '09:15', 450, 470, 448, 465), bar(D2, '09:16', 465, 466, 450, 452)]);
  opt('PE', [bar(D1, '15:29', 420, 420, 420, 420), bar(D2, '09:15', 380, 382, 370, 371), bar(D2, '09:16', 371, 380, 370, 379)]);
  const r = gapBacktest({ underlying: 'SENSEX', lateEntryPct: 0, startDate: D2, endDate: D2, capital: 200000, exitCandle: '0916', costToCostR: 0 }, s);
  assert.equal(r.best.trades[0].lotSize, 20);
  const small = gapBacktest({ underlying: 'SENSEX', startDate: D2, endDate: D2, minGapPts: 500 }, s);
  assert.match(small.days[0].reason, /^SENSEX gap 300 pts, below the 500-point threshold/);
  s.close();
});

test('previous close beyond the stored strikes: estimated on the high side from the nearest strike', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  // A 1,000-point gap: today's ATM 81000 was not stored yesterday (stored up to 80500).
  s.saveIndex('SENSEX', D1, D2, [bar(D1, '15:29', 80000, 80000, 80000, 80000), bar(D2, '09:15', 81000, 81100, 80990, 81080), bar(D2, '09:16', 81080, 81090, 81000, 81010)]);
  s.saveOptions('SENSEX', 1, 'CE', 5, D1, D1, [bar(D1, '15:29', 90, 90, 90, 90, { strike: 80500 })]);
  s.saveOptions('SENSEX', 1, 'PE', 5, D1, D1, [bar(D1, '15:29', 560, 560, 560, 560, { strike: 80500 })]);
  s.saveOptions('SENSEX', 1, 'CE', 0, D2, D2, [bar(D2, '09:15', 300, 330, 295, 320, { strike: 81000 }), bar(D2, '09:16', 320, 325, 310, 322, { strike: 81000 })]);
  s.saveOptions('SENSEX', 1, 'PE', 0, D2, D2, [bar(D2, '09:15', 280, 300, 270, 290, { strike: 81000 }), bar(D2, '09:16', 290, 295, 280, 285, { strike: 81000 })]);
  const r = gapBacktest({ underlying: 'SENSEX', lateEntryPct: 0, startDate: D2, endDate: D2, capital: 200000, exitCandle: '0916', costToCostR: 0 }, s);
  const [day] = r.days;
  // CE 81000 was further out of the money than 80500: at most 90. PE 81000 was deeper in the money: at most 560 + 500.
  assert.deepEqual([day.ce.prev, day.ce.prevEstimated, day.pe.prev, day.pe.prevEstimated], [90, true, 1060, true]);
  assert.equal(day.side, 'CE', 'CE opened 300 > 90 and closed green; PE 280 < 1060');
  assert.equal(r.best.trades[0].prevEstimated, true);
  s.close();
});

test('an estimated previous close that only the low end of its range would beat is reported as uncertain, not traded', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  s.saveIndex('SENSEX', D1, D2, [bar(D1, '15:29', 80000, 80000, 80000, 80000), bar(D2, '09:15', 79400, 79450, 79300, 79350)]);
  // PE 79400 was 600 further out of the money than the stored 80000 (close 400): its close lay between 0.05 and 400.
  s.saveOptions('SENSEX', 1, 'PE', 0, D1, D1, [bar(D1, '15:29', 400, 400, 400, 400, { strike: 80000 })]);
  s.saveOptions('SENSEX', 1, 'CE', 0, D1, D1, [bar(D1, '15:29', 380, 380, 380, 380, { strike: 80000 })]);
  s.saveOptions('SENSEX', 1, 'PE', 0, D2, D2, [bar(D2, '09:15', 300, 330, 295, 320, { strike: 79400 })]);
  s.saveOptions('SENSEX', 1, 'CE', 0, D2, D2, [bar(D2, '09:15', 350, 352, 300, 310, { strike: 79400 })]);
  const [day] = gapBacktest({ underlying: 'SENSEX', startDate: D2, endDate: D2 }, s).days;
  assert.deepEqual([day.pe.prev, day.pe.prevLow, day.pe.uncertain, day.side], [400, 0.05, true, null]);
  assert.match(day.reason, /^gap uncertain: PE previous close estimated/);
  s.close();
});

test('gap check on the index: up → CE whatever the premiums did; a stale 09:15 open is lifted to the intrinsic value', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  // SENSEX gaps up 1,000 and sells off inside the 09:15 minute; the ATM CE's first minute is red.
  s.saveIndex('SENSEX', D1, D2, [bar(D1, '15:29', 80000, 80000, 80000, 80000), bar(D2, '09:15', 81000, 81010, 80700, 80800), bar(D2, '09:16', 80800, 80850, 80780, 80820), bar(D2, '09:17', 80820, 80900, 80800, 80880)]);
  const o = (side, off, strike, rows) => s.saveOptions('SENSEX', 1, side, off, D1, D2, rows.map(r => ({ strike, ...r })));
  o('CE', 0, 80800, [bar(D1, '15:29', 30, 30, 30, 30), bar(D2, '09:15', 300, 300, 150, 200), bar(D2, '09:16', 200, 230, 195, 220), bar(D2, '09:17', 220, 260, 218, 250)]);
  o('PE', 0, 80800, [bar(D1, '15:29', 900, 900, 900, 900), bar(D2, '09:15', 100, 160, 90, 150), bar(D2, '09:16', 150, 155, 140, 145), bar(D2, '09:17', 145, 146, 120, 125)]);
  // ITM2 CE 80600: "opened" 20 (stale) with SENSEX at 81,000 → worth at least 400; the minute's high was 380.
  o('CE', -2, 80600, [bar(D2, '09:15', 20, 380, 20, 330), bar(D2, '09:16', 330, 360, 325, 350), bar(D2, '09:17', 350, 390, 348, 380)]);
  const run = signal => gapBacktest({ underlying: 'SENSEX', signal, startDate: D2, endDate: D2, capital: 100000, strike: 2, lateEntryPct: 5, dailySlPct: 50, exitCandle: '0916', costToCostR: 0, slippage: 0 }, s);
  const prem = run('premium');
  assert.equal(prem.days[0].side, null, 'ATM CE red, PE no gap: no trade on the premium rule');
  const idx = run('index');
  assert.equal(idx.days[0].side, 'CE');
  const [t] = idx.best.trades;
  assert.deepEqual([t.strike, t.entry], [80600, 399], 'entry from min(intrinsic 400, high 380) = 380, +5% = 399; not 20 × 1.05');
  const both = run('both');
  assert.equal(both.days[0].side, null);
  assert.match(both.days[0].reason, /gapped up 1000 pts, but the ATM CE premium did not gap up green/);
  s.close();
});

test('live gap check: the ATM premium gap alone (no colour), ATM at the index open, ₹ stop, live sizing', () => {
  const s = openHistory(':memory:'), D1 = '2026-03-02', D2 = '2026-03-03';
  // SENSEX opens 81,040 (ATM 81000 by the open), sells off to 80,800 (Dhan's rolling ATM 80800).
  s.saveIndex('SENSEX', D1, D2, [bar(D1, '15:29', 80000, 80000, 80000, 80000), bar(D2, '09:15', 81040, 81050, 80700, 80800), bar(D2, '09:16', 80800, 80850, 80780, 80820), bar(D2, '09:17', 80820, 80900, 80800, 80880)]);
  const o = (side, off, strike, rows) => s.saveOptions('SENSEX', 1, side, off, D1, D2, rows.map(r => ({ strike, ...r })));
  o('CE', 0, 81000, [bar(D1, '15:29', 40, 40, 40, 40)]);
  o('PE', 0, 81000, [bar(D1, '15:29', 1000, 1000, 1000, 1000)]);
  o('CE', 2, 81000, [bar(D2, '09:15', 300, 300, 200, 250), bar(D2, '09:16', 250, 260, 240, 255)]);   // red minute
  o('PE', -2, 81000, [bar(D2, '09:15', 250, 330, 240, 320), bar(D2, '09:16', 320, 325, 300, 310)]);
  o('CE', 0, 80800, [bar(D2, '09:15', 400, 410, 380, 400)]);   // the same contract as the ITM2 row below
  o('PE', 0, 80800, [bar(D2, '09:15', 150, 200, 140, 190)]);
  o('CE', 0, 80800, [bar(D1, '15:29', 70, 70, 70, 70)]);
  o('PE', 0, 80800, [bar(D1, '15:29', 820, 820, 820, 820)]);
  o('CE', -2, 80800, [bar(D2, '09:15', 400, 410, 380, 400), bar(D2, '09:16', 400, 420, 395, 415), bar(D2, '09:17', 415, 430, 410, 425)]);
  const base = { underlying: 'SENSEX', startDate: D2, endDate: D2, capital: 200000, strike: 2, lateEntryPct: 0, exitCandle: '0916', costToCostR: 0, slippage: 0 };
  const green = gapBacktest({ ...base, signal: 'premium', atmFrom: 'open' }, s);
  assert.equal(green.days[0].side, null, '81000 CE gapped up (40 → 300) but its minute was red');
  const live = gapBacktest({ ...base, signal: 'live', atmFrom: 'open', dailySlAmount: 10000, liveSizing: true, fundsUse: 100 }, s);
  assert.deepEqual([live.days[0].side, live.days[0].ce.strike], ['CE', 81000], 'live: the gap alone; ATM from the 81,040 open');
  const [t] = live.best.trades;
  // ITM2 from 81000 = 80800 CE at 400. Spend min(₹2L, ₹2L × 0.98 ÷ 1.15 = ₹170,434) → 21 lots × 20 = 420; stop ₹10,000 ÷ 420 = ₹23.81 below.
  assert.deepEqual([t.strike, t.entry, t.lots, t.qty, t.stop], [80800, 400, 21, 420, 376.2]);
  s.close();
});
