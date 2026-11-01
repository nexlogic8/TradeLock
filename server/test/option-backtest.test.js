import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niftyLotSize, optionTrades, secondWeeklyExpiry } from '../src/modules/scalper/option-backtest.js';

const t=m=>Date.parse(`2026-09-15T09:${String(m).padStart(2,'0')}:00+05:30`)/1000;
const row=(m,strike,open,high,low,close)=>({time:t(m),open,high,low,close,strike});
// Dhan rolling CE data for one day. The ATM moves from 23500 to 23450 at 09:24, so the 23500 contract
// is ATM until 09:23 and ATM+1 afterwards.
const series={
  0:[row(22,23500,60,62,58,61), row(23,23500,61,64,60,63), row(24,23450,40,42,38,41), row(25,23450,41,45,40,44), row(26,23450,44,50,43,49)],
  1:[row(22,23550,50,51,49,50), row(24,23500,64,66,62,65), row(25,23500,65,70,64,69), row(26,23500,69,75,68,74)],
};
const loader=data=>async(day,option,offset)=>{ assert.equal(day,'2026-09-15'); assert.equal(option,'CE'); return data[offset]||[]; };
const signal={time:t(23),entryAt:t(23),breakoutAt:t(22),direction:'CE',entry:23510};
const index=new Map([[t(25),23530],[t(26),23540]]);

test('NSE lot size follows the revision dates',()=>{
  assert.equal(niftyLotSize('2021-07-29'),75);
  assert.equal(niftyLotSize('2021-07-30'),50);
  assert.equal(niftyLotSize('2024-04-26'),25);
  assert.equal(niftyLotSize('2024-11-20'),75);
  assert.equal(niftyLotSize('2025-12-29'),75);
  assert.equal(niftyLotSize('2025-12-30'),65);
});

test('2nd weekly expiry: Tuesday from Sept 2025, Thursday before, moved back for market holidays',()=>{
  assert.equal(secondWeeklyExpiry('2026-09-15').date,'2026-09-22','on expiry day, that day is the nearest');
  assert.equal(secondWeeklyExpiry('2026-09-17').date,'2026-09-29');
  assert.equal(secondWeeklyExpiry('2025-08-20').date,'2025-08-28');
  assert.equal(secondWeeklyExpiry('2025-08-29').date,'2025-09-09','first Tuesday expiries after the switch');
  const open=new Set(['2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-23']);   // 22 Sept shut
  assert.deepEqual(secondWeeklyExpiry('2026-09-15',open),{date:'2026-09-21',estimated:false});
  assert.equal(secondWeeklyExpiry('2026-09-15').estimated,true,'without trading days it is a calendar estimate');
});

test('buys the ATM strike, follows it as the ATM rolls, and exits on the option chart',async()=>{
  const {trades:[trade],summary,candles}=await optionTrades([signal],{loadDay:loader(series),capital:10_000,exitLogic:'horizon',horizonBars:3,indexAt:x=>index.get(x)});
  const o=trade.option;
  assert.equal(o.strike,23500);
  assert.equal(o.expiry.date,'2026-09-22');
  assert.equal(o.entry,63,'entry = option close in the entry minute');
  assert.equal(o.lots,2,'₹10,000 / (63 × 65 = ₹4,095) = 2 whole lots');
  assert.equal(o.exit,74,'23500 CE close three option bars later, taken from the ATM+1 series');
  assert.equal(o.exitReason,'3m close');
  assert.equal(o.pnl,(74-63)*130);
  assert.equal(trade.points,30,'index move up to the option exit minute');
  assert.deepEqual(candles[signal.time].map(c=>c.close),[61,63,65,69,74],'the whole session of the 23500 contract, not the rolling ATM');
  assert.equal(summary.totalPnl,1430);
});

test('the SL is the option candle low in the index breakout minute, read on the option chart',async()=>{
  const dip={...series,1:[series[1][0],row(24,23500,64,66,57,60),...series[1].slice(2)]};
  const {trades:[trade]}=await optionTrades([signal],{loadDay:loader(dip),capital:10_000,stopLogic:'breakoutCandle',exitLogic:'horizon',horizonBars:3});
  assert.equal(trade.option.sl,58,'09:22 option low');
  assert.equal(trade.option.exit,58);
  assert.equal(trade.option.exitReason,'Option SL (breakout candle)');
  const gap={...series,1:[series[1][0],row(24,23500,55,56,52,54),...series[1].slice(2)]};
  assert.equal((await optionTrades([signal],{loadDay:loader(gap),capital:10_000,stopLogic:'breakoutCandle',exitLogic:'horizon',horizonBars:3})).trades[0].option.exit,55,'a gap through the SL fills at the open');
});

test('level rejection runs on the premium: three swing highs at its ceiling',async()=>{
  const m=(i,open,high,low,close)=>row(23+i,23500,open,high,low,close);
  const premium={0:[row(22,23500,60,62,58,61), m(0,61,64,60,63), m(1,63,80,62,78), m(2,76,77,70,72), m(3,72,78,71,77), m(4,77,76,70,71),
    m(5,71,79,70,76), m(6,76,77,68,70)]};
  const {trades:[trade]}=await optionTrades([signal],{loadDay:loader(premium),capital:10_000,exitLogic:'levelReject'});
  assert.equal(trade.option.exitReason,'Level rejection');
  assert.equal(trade.option.rejectLevel,80);
  assert.equal(trade.option.exit,70,'swing highs 80, 78 and 79 at the premium high; 09:29 confirms the third');
});

test('trades that cannot afford one lot are skipped and counted; missing prices are unavailable',async()=>{
  const {trades:[trade],summary}=await optionTrades([signal],{loadDay:loader(series),capital:4000,exitLogic:'horizon',horizonBars:3});
  assert.match(trade.option.skipped,/One lot costs ₹4,095/);
  assert.equal(summary.unaffordable,1);
  const none=await optionTrades([signal],{loadDay:loader({}),capital:10_000});
  assert.equal(none.summary.unavailable,1);
});

test('compounding sizes each trade from the running capital and records it after every trade',async()=>{
  const second={time:t(25),entryAt:t(25),direction:'CE',entry:23460};
  // Trade 1 (23500 CE, 63 → 74 after 3 bars): 2 lots, +₹1,430, so ₹8,190 becomes ₹9,620.
  // Trade 2 (23450 CE, 44 → 52 three bars later, one lot ₹2,860): compounding buys 3 lots (+₹1,560), fixed 2 (+₹1,040).
  const longer={...series,0:[...series[0],row(27,23450,49,52,48,50),row(28,23450,50,53,49,52)]};
  const run=sizing=>optionTrades([second,signal],{loadDay:loader(longer),capital:8190,sizing,exitLogic:'horizon',horizonBars:3});
  const compound=await run('compound');
  assert.deepEqual(compound.trades.map(x=>x.option.lots),[2,3],'trades are replayed in time order');
  assert.deepEqual(compound.trades.map(x=>x.option.capitalAfter),[9620,11180]);
  assert.equal(compound.summary.returnPct,36.51,'(11180 - 8190) / 8190');
  const fixed=await run('fixed');
  assert.deepEqual(fixed.trades.map(x=>x.option.lots),[2,2]);
  assert.deepEqual(fixed.trades.map(x=>x.option.capitalAfter),[9620,10660]);
});

test('option bars after 15:29 are ignored: the session close exit is the 15:29 bar',async()=>{
  const at=hhmm=>Date.parse(`2026-09-15T${hhmm}:00+05:30`)/1000;
  const late={0:[{time:at('15:27'),open:60,high:62,low:59,close:61,strike:23500},{time:at('15:28'),open:61,high:63,low:60,close:62,strike:23500},
    {time:at('15:29'),open:62,high:64,low:61,close:63,strike:23500},{time:at('15:39'),open:70,high:71,low:69,close:70,strike:23500}]};
  const {trades:[trade],candles}=await optionTrades([{time:at('15:27'),direction:'CE',entry:23500}],{loadDay:loader(late),capital:10_000,exitLogic:'levelReject'});
  assert.equal(trade.option.exitReason,'Session close');
  assert.equal(trade.option.exit,63);
  assert.equal(candles[at('15:27')].length,3);
});
