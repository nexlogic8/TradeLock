import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingRange, orb5Backtest, sessions, simulateDay, tradeStats } from '../src/modules/scalper/orb5.js';
import { expiryFor, optionCharges, orb5OptionTrades } from '../src/modules/scalper/orb5-options.js';

// Candle helper: time in IST on a given day, OHLC.
const at=(day,hhmm)=>Date.parse(`${day}T${hhmm}:00+05:30`)/1000;
const D='2026-10-13';
const bar=(hhmm,open,high,low,close,day=D)=>({time:at(day,hhmm),open,high,low,close});
// Opening range 09:15-09:19: high 110 (a wick at 09:17), low 95 (a wick at 09:16).
const rangeBars=(day=D)=>[bar('09:15',100,104,98,102,day),bar('09:16',102,103,95,101,day),bar('09:17',101,110,100,104,day),bar('09:18',104,106,101,103,day),bar('09:19',103,105,100,104,day)];
const run=(bars,settings={})=>{ const range=openingRange(bars); return simulateDay(bars,range,settings).filter(t=>!t.skipped); };

test('range uses the 09:15-09:19 highs and lows including wicks, frozen at 09:20',()=>{
  const range=openingRange(rangeBars());
  assert.deepEqual(range,{high:110,low:95,frozenAt:at(D,'09:20')});
  const missing=openingRange(rangeBars().filter(b=>b.time!==at(D,'09:18')));
  assert.equal(missing.skipped,'Missing opening-range candle 09:18');
});

test('each day gets its own range; incomplete days are skipped and reported',()=>{
  const day2='2026-10-14';
  const rows=[...rangeBars(),bar('09:20',104,108,103,107),
    ...rangeBars(day2).map(b=>({...b,high:b.high+50,low:b.low+50,open:b.open+50,close:b.close+50})),bar('09:20',154,158,153,157,day2),
    bar('09:15',100,101,99,100,'2026-10-15'),bar('09:16',100,101,99,100,'2026-10-15')];
  const result=orb5Backtest(rows,{startDay:D,endDay:'2026-10-15',now:at('2026-10-16','09:00')*1000});
  assert.deepEqual(result.days.map(d=>[d.day,d.rangeHigh??null,d.rangeLow??null,d.skipped??null]),[
    [D,110,95,null],[day2,160,145,null],['2026-10-15',null,null,'Missing opening-range candles 09:17, 09:18, 09:19']]);
  assert.equal(result.summary.skippedDays,1);
  assert.equal(sessions(rows).size,3);
});

test('a close-through after a close inside triggers; wicks and closes inside the range do not',()=>{
  const bars=[...rangeBars(),
    bar('09:20',104,112,103,109),     // wick above 110 but closes inside: no signal
    bar('09:21',109,111,105,108),     // inside: no-trade zone
    bar('09:22',108,113,107,112),     // closes 112 > 110 with prior close 108 <= 110: CE signal (low 107)
    bar('09:23',112.5,114,111,113),   // execution at this open
    bar('09:24',113,118,112,117)];
  const [trade]=run(bars);
  assert.equal(trade.direction,'CE');
  assert.equal(trade.signalAt,at(D,'09:22'));
  assert.equal(trade.entryAt,at(D,'09:23'),'executes at the next candle, never on the signal candle');
  assert.equal(trade.entry,112.5,'at that candle\'s open');
  assert.equal(trade.stop,107,'CE stop = signal candle low');
  assert.equal(trade.target,123.5,'2R: 112.5 + 2 × 5.5');
  // Stopped out while price stays above the range: the next close above is not a fresh crossing.
  const noRetrigger=[...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',111,112,106,111),bar('09:22',111,114,110.5,113),bar('09:23',113,114,112,113.5)];
  const trades=run(noRetrigger);
  assert.equal(trades.length,1);
  assert.equal(trades[0].exitReason,'Stop');
});

test('PE: stop at the signal high, target hit inside a later candle',()=>{
  const bars=[...rangeBars(),bar('09:20',99,99.5,93,94),bar('09:21',93.5,94,92,92.5),bar('09:22',92.5,93,75,80)];
  const [trade]=run(bars);
  assert.equal(trade.direction,'PE');
  assert.equal(trade.entry,93.5);
  assert.equal(trade.stop,99.5);
  assert.equal(trade.target,81.5,'93.5 − 2 × 6');
  assert.equal(trade.exitReason,'Target');
  assert.equal(trade.exit,81.5);
  assert.equal(trade.r,2);
});

test('stops: inside the candle, gapped through (fills at the open) and ambiguous candles (stop first)',()=>{
  const signal=[...rangeBars(),bar('09:20',108,112,107,111)];   // CE signal, stop 107
  const inside=run([...signal,bar('09:21',111,112,110.5,111.5),bar('09:22',111.5,112,106,108)]);
  assert.deepEqual([inside[0].exitReason,inside[0].exit,inside[0].r],['Stop',107,-1]);
  const gap=run([...signal,bar('09:21',111,112,110.5,111.5),bar('09:22',105,106,103,104)]);
  assert.deepEqual([gap[0].exitReason,gap[0].exit],['Stop (gap)',105]);
  const both=run([...signal,bar('09:21',111,130,106,120)]);
  assert.equal(both[0].exitReason,'Stop');
  assert.equal(both[0].ambiguous,true);
});

test('a completed close back inside the range exits at the next open',()=>{
  const trades=run([...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',111,112.5,110.5,112),bar('09:22',112,112.2,108,109),bar('09:23',109.5,110,108,109)]);
  assert.equal(trades[0].exitReason,'Closed back inside range');
  assert.equal(trades[0].exitAt,at(D,'09:23'));
  assert.equal(trades[0].exit,109.5);
});

test('one position at a time, at most N entries per day, and no execution beyond the stop',()=>{
  // Signal 1 at 09:20 (CE); back inside at 09:22 → exit 09:23; signal 2 at 09:24 (CE); exit 09:26; signal 3 at 09:27.
  const bars=[...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',111,112,110.5,111.5),bar('09:22',111,111.5,108,109),
    bar('09:23',109,110,108,109.5),bar('09:24',109.5,113,109,112),bar('09:25',112,113,111,112.5),bar('09:26',112,112.5,108,109),
    bar('09:27',109,110,108.5,109.5),bar('09:28',109.5,114,109,113),bar('09:29',113,114,112,113.5),bar('09:30',113,114,112,113.5)];
  assert.equal(run(bars).length,2,'default limit of two entries');
  assert.equal(run(bars,{maxEntriesPerDay:3}).length,3);
  assert.equal(run(bars,{maxEntriesPerDay:1}).length,1);
  // Open gaps below the CE stop: the entry is skipped and reported.
  const day=simulateDay([...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',106,107,105,106)],openingRange(rangeBars()),{});
  assert.equal(day[0].skipped,'Execution price is beyond the stop');
});

test('square-off at the configured time; no entries at or after it',()=>{
  const above=t=>bar(t,111,112,110.5,111.5);
  const hold=[...rangeBars(),bar('09:20',108,112,107,111),above('09:21'),above('15:14'),bar('15:15',111.2,112,111,111.5)];
  const [sq]=run(hold);
  assert.deepEqual([sq.exitReason,sq.exitAt,sq.exit],['Square-off',at(D,'15:15'),111.2]);
  const early=run(hold,{squareOff:'09:22'});
  assert.equal(early[0].exitAt,at(D,'15:14'),'the first candle at or after a 09:22 square-off is 15:14 in this data');
  // 15:14 closes above the range (signal) but would execute at 15:15, the square-off: no entry.
  const signalAtCutoff=simulateDay([...rangeBars(),bar('09:20',104,106,103,105),bar('15:14',105,112,104,111),bar('15:15',111,112,110,111)],openingRange(rangeBars()),{});
  assert.equal(signalAtCutoff.filter(t=>!t.skipped).length,0);
  assert.equal(signalAtCutoff.find(t=>t.skipped)?.skipped,'Execution at or after square-off');
});

test('slippage worsens both fills in points; R uses the actual entry-to-stop distance',()=>{
  const [t]=run([...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',111,125,110.5,124)],{slippagePoints:1,riskReward:1});
  assert.equal(t.entry,112,'111 open + 1');
  assert.equal(t.target,117,'1R: 112 + (112 − 107)');
  assert.equal(t.exit,116,'target fill 117 − 1');
});

test('stats: win rate, averages, expectancy, profit factor and drawdown',()=>{
  assert.deepEqual(tradeStats([10,-5,20,-5,-5]),{trades:5,wins:2,losses:3,winRate:40,averageWin:15,averageLoss:-5,expectancy:3,profitFactor:2,net:15,maxDrawdown:10});
});

test('option charges follow the 1 Oct 2024 revision',()=>{
  const after=optionCharges('2026-10-13',10_000,12_000,{brokeragePerOrder:20});
  assert.equal(after.stt,12,'0.1% of the sell premium');
  assert.equal(after.exchange,7.71,'0.03503% of turnover');
  assert.equal(after.stamp,0.3);
  assert.equal(optionCharges('2024-09-30',10_000,12_000).stt,7.5,'0.0625% before the revision');
  assert.equal(optionCharges('2026-10-13',10_000,12_000,{brokeragePerOrder:20,statutoryCharges:false}).total,40);
  assert.equal(expiryFor('2026-09-15','W1').date,'2026-09-15');
  assert.equal(expiryFor('2026-09-15','M1').date,'2026-09-29','last Tuesday of September 2026');
  assert.equal(expiryFor('2025-08-20','M1').date,'2025-08-28','last Thursday before the Tuesday switch');
});

test('options mode buys the selected strike at the execution open and prices the NIFTY exit from its premium',async()=>{
  const trade={day:D,direction:'CE',signalAt:at(D,'09:20'),time:at(D,'09:21'),entryAt:at(D,'09:21'),exitAt:at(D,'09:24'),exitAtOpen:false,exitReason:'Target'};
  const row=(hhmm,strike,o,c)=>({time:at(D,hhmm),open:o,high:Math.max(o,c)+1,low:Math.min(o,c)-1,close:c,strike});
  const data={0:[row('09:20',23500,100,101),row('09:21',23500,101,102),row('09:24',23550,90,95)],
    '-1':[row('09:20',23450,130,131),row('09:21',23450,131,133),row('09:24',23500,121,140)]};
  const loadDay=async(day,option,offset)=>data[offset]||[];
  const {trades:[t],summary}=await orb5OptionTrades([trade],{loadDay,moneyness:1,lots:2,brokeragePerOrder:20,slippagePerUnit:0.5,statutoryCharges:false});
  assert.equal(t.option.strike,23450,'1 ITM call = ATM at the signal (23500) − 50');
  assert.equal(t.option.entry,131.5,'23450 CE open at 09:21 + ₹0.5');
  assert.equal(t.option.exit,132.5,'its 09:24 bar is missing (ATM−2 not loaded): previous bar close 133 − ₹0.5');
  assert.equal(t.option.exitPriceFrom,'previous bar close');
  const atm=await orb5OptionTrades([trade],{loadDay,moneyness:0,lots:1,slippagePerUnit:0,statutoryCharges:false});
  assert.equal(atm.trades[0].option.strike,23500);
  assert.equal(atm.trades[0].option.exit,140,'09:24 bar of the 23500 contract (ATM−1 then), its close');
  assert.equal(atm.trades[0].option.pnl,(140-101)*65-40);
  assert.equal(summary.trades,1);
});

test('opposite-candle exit: the first red 1-minute candle, or the first red 5-minute candle, exits a CE at the next open',()=>{
  const bars=[...rangeBars(),bar('09:20',108,112,107,111),bar('09:21',111,112.5,110.8,112),bar('09:22',112,112.2,111,111.5),bar('09:23',111.5,112,111.2,111.8),bar('09:24',111.8,112,111,111.2),
    bar('09:25',111.3,111.6,110.8,111),bar('09:26',111,111.2,110.6,110.9),bar('09:27',110.9,111,110.5,110.7),bar('09:28',110.7,110.9,110.4,110.6),bar('09:29',110.6,110.8,110.2,110.5),bar('09:30',110.4,110.6,110.1,110.3)];
  assert.equal(run(bars)[0].exitReason,'Session end (data)','off: neither exits it here');
  const one=run(bars,{oppositeExit:'1m'})[0];
  assert.deepEqual([one.exitReason,one.exitAt,one.exit],['Opposite 1-min candle 09:22',at(D,'09:23'),111.5]);
  const five=run(bars,{oppositeExit:'5m'})[0];
  assert.deepEqual([five.exitReason,five.exitAt,five.exit],['Opposite 5-min candle 09:25',at(D,'09:30'),110.4],'09:20–09:24 closed green (108 → 111.2); 09:25–09:29 red');
});
