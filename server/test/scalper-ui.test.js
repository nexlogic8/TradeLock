const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const page = (await import('../../web/js/pages/scalper.js')).default;
const { store } = await import('../../web/js/core/store.js');
store.set({ user: { admin: true } });   // administrators see the chart strategies; the user view is tested at the end

test('users (not administrators): no strategy switches or signal subtitles, clean charts', () => {
  store.set({ user: { admin: false } });
  try {
    const data = { expiry:'2026-10-15',expiries:['2026-10-15'],asOf:Date.now(),marketOpen:true,
      underlying:{ltp:25010,candles:[]}, strikes:[], selectedCharts:{ce:[],pe:[]}, broker:{connected:false} };
    const view = String(page.view({data,ui:{interval:'5',ceCandles:[],peCandles:[],quantity:1},el:{}}));
    assert.doesNotMatch(view,/data-strategy="orb"|data-scm-strats|Chart strategies/);
    assert.doesNotMatch(view,/breakout arrows|hammer/i);
    assert.match(view,/EMA 9 \/ EMA 21/);
  } finally { store.set({ user: { admin: true } }); }
});

test('Power Scalper renders the three-chart workspace, chain and one-tap order tickets', () => {
  const call = { securityId:'101',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-10-15 25000 CE',strike:25000,option:'CE',expiry:'2026-10-15',ltp:125.5 };
  const put = { securityId:'102',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-10-15 25000 PE',strike:25000,option:'PE',expiry:'2026-10-15',ltp:130.2 };
  const data = { expiry:'2026-10-15',expiries:['2026-10-15'],asOf:Date.now(),marketOpen:true,
    underlying:{ltp:25010,candles:[{time:Date.now(),open:25000,high:25020,low:24990,close:25010,volume:100}]},
    strikes:[{strike:25000,ce:call,pe:put}],selectedCharts:{ce:[],pe:[]},broker:{connected:true} };
  const view = String(page.view({data,ui:{ceId:'101',peId:'102',selectedStrike:25000,interval:'5',ceCandles:[],peCandles:[],quantity:1},el:{}}));
  assert.equal((view.match(/class="sc-chart-host"/g)||[]).length,3);
  assert.equal((view.match(/data-chart-control="x-in"/g)||[]).length,3);
  assert.equal((view.match(/data-chart-control="y-in"/g)||[]).length,3);
  // 5-minute charts: EMA 9 / 21, and the 1-minute hammer strategy markers are not shown.
  // Each chart has its ƒx Indicators button, a live legend and its settings panel (EMA 9 / 21 by default, see chart-studies.test.js).
  for (const key of ['ce','spot','pe']) {
    assert.match(view,new RegExp(`data-studies="${key}"[^>]*>ƒx Indicators</button><span class="sc-legend" data-legend="${key}"></span>`));
    assert.match(view,new RegExp(`data-studies-pop="${key}" role="dialog" aria-label="Indicators" hidden`));
  }
  assert.match(view,/EMA 9 \/ EMA 21 · 5m opening-range breakout arrows · hammer signals on 1-minute/);
  const oneMinute=String(page.view({data,ui:{ceId:'101',peId:'102',selectedStrike:25000,interval:'1',ceCandles:[],peCandles:[],quantity:1},el:{}}));
  assert.match(oneMinute,/data-studies="spot"/);
  assert.match(oneMinute,/EMA45 wick-touch hammer \+ 5m opening-range breakout arrows · next candle confirms/);
  assert.match(view,/NIFTY 50 · LIVE/); assert.match(view,/data-order-side="BUY"/); assert.match(view,/data-order-side="SELL"/);
  // Index selector, full screen and the chain / positions / both toggle.
  assert.match(view,/data-underlying="NIFTY" aria-pressed="true">NIFTY 50</);
  assert.match(view,/data-underlying="BANKNIFTY" aria-pressed="false">BANK NIFTY</);
  assert.match(view,/data-underlying="SENSEX" aria-pressed="false">SENSEX</);
  assert.match(view,/id="sc-fullscreen"[^>]*>.*<span class="sc-fs-text"><span class="sc-fs-long">Full screen<span class="sc-fs-trade"> · trade<\/span><\/span><span class="sc-fs-short">Trade<\/span><\/span><\/button>/);
  assert.match(view,/class="panel scalper-chain side-chain/);
  assert.match(view,/data-side-panel="positions" aria-pressed="false">Positions</);
  assert.doesNotMatch(view,/Confirm and send|sc-confirm/,'one tap sends the order: no confirmation dialog');
});

test('Power Scalper resets stale option selections to the current ATM contracts on load', async()=>{
  const call={securityId:'201'},put={securityId:'202'};
  const data={expiry:'2026-10-20',expiries:['2026-10-20'],strikes:[{strike:25000,ce:call,pe:put}],
    underlying:{ltp:25010,candles:[]},selectedCharts:{ce:[],pe:[]},selectedOpeningRanges:{},broker:{connected:true}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  const ui={ceId:'expired-ce',peId:'expired-pe',selectedStrike:24000};
  try {
    await page.load({ui});
    assert.equal(ui.ceId,'201');
    assert.equal(ui.peId,'202');
    assert.equal(ui.selectedStrike,25000);
  } finally { globalThis.fetch=originalFetch; }
});

test('Power Scalper explains an empty option chain instead of rendering a blank panel',()=>{
  const data={expiry:'2026-10-20',expiries:['2026-10-20'],strikes:[],asOf:Date.now(),
    underlying:{ltp:25010,candles:[]},selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const view=String(page.view({data,ui:{interval:'1'},el:{}}));
  assert.match(view,/No contracts returned for this expiry/);
});

test('Power Scalper sizes lots automatically: 20% SL on the premium, risk = daily loss ÷ max trades',()=>{
  const call={securityId:'501',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 CE',strike:22700,option:'CE',expiry:'2026-11-03',ltp:100};
  const put={securityId:'502',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 PE',strike:22700,option:'PE',expiry:'2026-11-03',ltp:40};
  const data={expiry:'2026-11-03',expiries:['2026-11-03'],asOf:Date.now(),lotSize:65,underlying:{ltp:22700,candles:[]},
    strikes:[{strike:22700,ce:call,pe:put}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  // 5% daily loss on ₹2,17,685.40 capital over 3 trades = ₹3,628.09 per trade.
  const budget={capital:217685.4,daily:10884.27,trades:3,dailyPct:5,percent:1.67,perTrade:3628.09,available:3628.09};
  const margins={ce:{securityId:'501',lots:2,qty:130,lotSize:65,buy:13000,sell:150000,available:204713.48}};
  const view=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'1',margins,signalRisk:{budget}},el:{}}));
  // CE ₹100: SL ₹80 risks ₹20 × 65 = ₹1,300 a lot → floor(3628.09 / 1300) = 2 lots.
  assert.match(view,/data-lots="ce"[^>]*>2<\/output>/);
  assert.match(view,/2 lots × 65 · SL ₹80\.00 \(−20%\) · risk ₹2,600 of ₹3,628 \(5% ÷ 3 trades\) · capital ₹13,000 · available ₹2,04,713/);
  assert.match(view,/data-funds="buy">₹13,000</);
  // PE ₹40 (independent): ₹8 × 65 = ₹520 a lot → 6 lots, ₹15,600 capital.
  assert.match(view,/data-lots="pe"[^>]*>6<\/output>/);
  assert.match(view,/6 lots × 65 · SL ₹32\.00 \(−20%\) · risk ₹3,120 of ₹3,628/);
  assert.doesNotMatch(view,/<input[^>]*sc-lots-input/,'lots cannot be typed');
  // Without risk rules nothing can be sized, so orders are disabled with the reason.
  const unset=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'1'},el:{}}));
  assert.match(unset,/Set a daily loss limit in Risk rules to size orders/);
  assert.match(unset,/data-order-side="BUY" data-option="CE" disabled/);
  // Daily loss used up: no new risk.
  const spent=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'1',signalRisk:{budget:{...budget,available:0}}},el:{}}));
  assert.match(spent,/Daily loss limit reached/);
});


test('the funds warning names the order it applies to (buy affordable, writing not)',()=>{
  const put={securityId:'602',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-10-19 22600 PE',strike:22600,option:'PE',expiry:'2026-10-19',ltp:133.4};
  const data={expiry:'2026-10-19',expiries:['2026-10-19'],asOf:Date.now(),lotSize:65,underlying:{ltp:22622.7,candles:[]},
    strikes:[{strike:22600,ce:null,pe:put}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const budget={perTrade:5442.14,available:5442.14,trades:2,dailyPct:5};
  const margins={pe:{securityId:'602',lots:6,qty:390,lotSize:65,buy:52026,sell:928925,available:199003}};
  const view=String(page.view({data,ui:{peId:'602',interval:'1',margins,signalRisk:{budget,optionSlPct:10}},el:{}}));
  assert.match(view,/6 lots × 65 · SL ₹120\.06 \(−10%\) · risk ₹5,203 of ₹5,442 \(5% ÷ 2 trades\) · capital ₹52,026 · available ₹1,99,003 · enough to buy; selling \(writing\) needs more margin/);
  assert.doesNotMatch(view,/not enough funds to buy/);
});

test('EMA periods follow the chart interval',async()=>{
  const { emaPeriods } = await import('../../web/js/pages/scalper.js');
  assert.deepEqual(emaPeriods('1'),{fast:45,slow:105});
  for (const interval of ['5','15','25','60']) assert.deepEqual(emaPeriods(interval),{fast:9,slow:21});
});

test('SENSEX chain: BSE contracts, index labels, no AI signal panel, positions panel',()=>{
  const call={securityId:'1111226',exchangeSegment:'BSE_FNO',symbol:'SENSEX 2026-10-15 73000 CE',underlying:'SENSEX',strike:73000,option:'CE',expiry:'2026-10-15',ltp:145.7};
  const put={securityId:'1111227',exchangeSegment:'BSE_FNO',symbol:'SENSEX 2026-10-15 73000 PE',underlying:'SENSEX',strike:73000,option:'PE',expiry:'2026-10-15',ltp:120};
  const strikes=[72800,72900,73000,73100,73200].map(strike=>({strike,ce:strike===73000?call:{...call,securityId:`c${strike}`,strike},pe:strike===73000?put:{...put,securityId:`p${strike}`,strike}}));
  const data={expiry:'2026-10-15',expiries:['2026-10-15','2026-10-22'],asOf:Date.now(),lotSize:20,underlyingKey:'SENSEX',optionSegment:'BSE_FNO',
    underlying:{symbol:'SENSEX',key:'SENSEX',securityId:'51',ltp:72957.94,candles:[]},strikes,selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const dash={positions:[{symbol:'SENSEX 2026-10-15 73000 CE',qty:40,avg:140.5,unrealized:208}],orders:[]};
  const view=String(page.view({data,ui:{ceId:'1111226',peId:'1111227',interval:'5',underlying:'SENSEX',sidePanel:'both'},el:{},state:{dash}}));
  assert.match(view,/data-underlying="SENSEX" aria-pressed="true"/);
  assert.match(view,/SENSEX 2026-10-15 73000 CE · 5 · BSE/,'option chart heading names the index and BSE');
  assert.match(view,/SENSEX · 5 · IDX/);
  assert.match(view,/<b><span class="tk-full">SENSEX 2026-10-15 73000 CALL<\/span><span class="tk-short">73000 CE<\/span><\/b>/,'ticket heading (full, and short for phones)');
  assert.doesNotMatch(view,/data-ai-signal|AI signal/,'the AI signal panel is removed from Power Scalper');
  assert.match(view,/class="panel scalper-chain side-both/);
  assert.match(view,/SENSEX 2026-10-15 73000 CE<\/b><small><span class="pos">LONG<\/span> 40 @ 140\.50/);
  assert.match(view,/data-sc-exit="SENSEX 2026-10-15 73000 CE"/);
  assert.match(view,/\+₹208/);
});

test('strategy switches: both chart strategies listed, on by default, off when saved off',()=>{
  const call={securityId:'101',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-10-15 25000 CE',strike:25000,option:'CE',expiry:'2026-10-15',ltp:125.5};
  const data={expiry:'2026-10-15',expiries:['2026-10-15'],asOf:Date.now(),underlying:{ltp:25010,candles:[]},strikes:[{strike:25000,ce:call,pe:null}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const on=String(page.view({data,ui:{ceId:'101',interval:'5',strategies:{orb:true,hammer:true}},el:{}}));
  assert.match(on,/role="switch" data-strategy="orb" aria-checked="true"[^>]*><i aria-hidden="true"><\/i>ORB 5m</);
  assert.match(on,/data-strategy="hammer" aria-checked="true"[^>]*><i aria-hidden="true"><\/i>Hammer 1m</, 'the 1-minute chart is back, so Hammer 1m can be switched on');
  assert.match(on,/data-strategy="ema25" aria-checked="true"[^>]*><i aria-hidden="true"><\/i>EMA 5\/9 1m</, 'EMA 5/9 scalp listed, on by default');
  const off=String(page.view({data,ui:{ceId:'101',interval:'5',strategies:{orb:false,hammer:true}},el:{}}));
  assert.match(off,/data-strategy="orb" aria-checked="false"/);
});

test('one trade at a time on the tickets, and the chart starts at 5 minutes', async () => {
  const { runningTrade, INTERVALS } = await import('../../web/js/pages/scalper.js');
  assert.deepEqual(INTERVALS.map(([v]) => v), ['1', '5', '15', '25', '60'], '1-minute chart available (EMA 5/9, Hammer); the page still opens on 5 minutes');
  const call={securityId:'501',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 CE',strike:22700,option:'CE',expiry:'2026-11-03',ltp:100};
  const data={expiry:'2026-11-03',expiries:['2026-11-03'],asOf:Date.now(),lotSize:65,underlying:{ltp:22700,candles:[]},strikes:[{strike:22700,ce:call,pe:null}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const budget={capital:217685.4,daily:10884.27,trades:3,dailyPct:5,percent:1.67,perTrade:3628.09,available:3628.09};
  const busyState={dash:{positions:[{symbol:'NIFTY-Oct2026-22950-PE',qty:65,avg:144.5,unrealized:-200}],orders:[]}};
  const view=String(page.view({data,ui:{ceId:'501',interval:'5',signalRisk:{budget}},el:{},state:busyState}));
  assert.match(view,/<option value="5" selected>5 min<\/option>/);
  assert.match(view,/<option value="1" >1 min<\/option><option value="5" selected>5 min/, "1 min offered, 5 min selected by default");
  assert.match(view,/sc-ticket busy/);
  assert.match(view,/data-order-side="BUY" data-option="CE" disabled/);
  assert.match(view,/A trade is running \(NIFTY-Oct2026-22950-PE\)\. Exit it from Positions before taking the next one\./);
  assert.equal(runningTrade({dash:{positions:[{symbol:'X',qty:0}],orders:[]}}),'','a closed position does not block');
  assert.match(runningTrade({dash:{broker:{algoOn:true},positions:[],orders:[]}}),/Algo Trading is on: manual entries are off/,'Algo Trading on: Buy / Sell are disabled');
  assert.equal(runningTrade({dash:{broker:{algoOn:true,manualOn:true},positions:[],orders:[]}}),'','manual trades allowed: Buy / Sell stay on');
  assert.match(runningTrade({dash:{positions:[],orders:[{id:'O1'}]}}),/pending/);
  assert.match(runningTrade({dash:{positions:[],orders:[]}},{orderInFlight:Date.now()}),/being confirmed/);
});

test('order button amounts of a lakh or more are shown in lakhs so they fit a phone button', async () => {
  const { compactRupees } = await import('../../web/js/pages/scalper.js');
  assert.equal(compactRupees(1428442), '₹14.28L');
  assert.equal(compactRupees(100000), '₹1.00L');
  assert.equal(compactRupees(57067), '₹57,067');
});

test('order buttons show the full-quantity amount (Sell left, Buy right) without a "Margin" label; phone full-screen parts render', () => {
  const call={securityId:'501',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 CE',strike:22700,option:'CE',expiry:'2026-11-03',ltp:100};
  const put={securityId:'502',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 PE',strike:22700,option:'PE',expiry:'2026-11-03',ltp:40};
  const data={expiry:'2026-11-03',expiries:['2026-11-03'],asOf:Date.now(),lotSize:65,underlying:{ltp:22700,candles:[]},strikes:[{strike:22700,ce:call,pe:put}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const margins={ce:{securityId:'501',lots:2,qty:130,lotSize:65,buy:13000,sell:1428442,available:204713}};
  const budget={capital:217685.4,daily:10884.27,trades:3,dailyPct:5,percent:1.67,perTrade:3628.09,available:3628.09};
  const view=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'5',margins,signalRisk:{budget},mSide:'pe'},el:{},state:{dash:{pnl:-7197.75,positions:[],orders:[]}}}));
  // Sell (left) and Buy (right) show the amount for the full quantity, not the per-unit price.
  assert.match(view,/data-order-side="SELL" data-option="CE" ><span>Sell<\/span><small title="[^"]*" data-funds="sell">₹14\.28L<\/small><\/button>[\s\S]*data-order-side="BUY" data-option="CE" ><span>Buy<\/span><small title="[^"]*" data-funds="buy">₹13,000<\/small><\/button>/);
  assert.doesNotMatch(view,/>Margin /);
  assert.match(view,/class="scm-top"/);
  assert.match(view,/data-scm-pnl class="neg">−₹7,198/);
  assert.match(view,/class="scalper-chart-grid mside-pe"/);
  assert.match(view,/<b class="scm-ce">03 Nov 22700 Call<\/b><b class="scm-pe">03 Nov 22700 Put<\/b>/);
  // the premium row opens the chain; ⇅ swaps Call / Put; Strategy dropdown and ƒx indicators in the tool row
  assert.match(view,/class="scm-side-pick" data-open-sheet="chain"/);
  assert.match(view,/class="scm-swap" data-mside-toggle/);
  assert.match(view,/data-scm-strats[^>]*>Strategy/);
  assert.match(view,/class="scm-check" role="menuitemcheckbox" data-strategy="orb"/);
  assert.match(view,/class="scm-tool scm-fx" data-studies="spot"/);
  assert.doesNotMatch(view,/scm-link/);
});

test('desktop layout switch: Classic / Split icons, right strip, Sell · lots · Buy in the option chart headers', () => {
  const call={securityId:'501',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 CE',strike:22700,option:'CE',expiry:'2026-11-03',ltp:100};
  const put={securityId:'502',exchangeSegment:'NSE_FNO',symbol:'NIFTY 2026-11-03 22700 PE',strike:22700,option:'PE',expiry:'2026-11-03',ltp:40};
  const data={expiry:'2026-11-03',expiries:['2026-11-03'],asOf:Date.now(),lotSize:65,underlying:{ltp:22700,candles:[]},strikes:[{strike:22700,ce:call,pe:put}],selectedCharts:{ce:[],pe:[]},broker:{connected:true}};
  const budget={capital:217685.4,daily:10884.27,trades:3,dailyPct:5,percent:1.67,perTrade:3628.09,available:3628.09};
  const view=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'5',layout:'split',signalRisk:{budget}},el:{},state:{dash:{positions:[],orders:[]}}}));
  // Icon buttons (tooltip + accessible name), not text.
  assert.match(view,/data-layout="classic" aria-pressed="false" title="Classic:[^"]*" aria-label="Classic layout"><svg/);
  assert.match(view,/data-layout="split" aria-pressed="true" title="Split:[^"]*" aria-label="Split layout"><svg/);
  // Right strip: Option chain / Positions / Both, the open section pressed.
  assert.match(view,/<nav class="sc-rail"[^>]*><button type="button" data-rail="chain" aria-pressed="true" title="Option chain"><svg[\s\S]*data-rail="positions" aria-pressed="false"[\s\S]*data-rail="both"/);
  assert.doesNotMatch(view,/sc-split-tools/,'the old Option chain / Positions text buttons are gone');
  // Buy shows the full amount for the auto lots (2 lots × 65 × ₹100); Sell shows the margin once loaded.
  assert.match(view,/data-order-side="SELL" data-option="CE" data-hdr-btn="ce" >Sell <small data-hdr-funds="ce-sell">[^<]*<\/small><\/button><span class="sc-hdr-lots" data-hdr-lots="ce">2 lots<\/span><button type="button" class="btn btn-sm sc-hdr-buy" data-order-side="BUY" data-option="CE" data-hdr-btn="ce" >Buy <small data-hdr-funds="ce-buy">₹13,000<\/small>/);
  assert.match(view,/data-hdr-lots="pe">6 lots</);
  const busy=String(page.view({data,ui:{ceId:'501',peId:'502',interval:'5',layout:'split',signalRisk:{budget}},el:{},state:{dash:{positions:[{symbol:'X',qty:65}],orders:[]}}}));
  assert.match(busy,/data-option="CE" data-hdr-btn="ce" disabled>Sell/,'one trade at a time applies to the header buttons too');
});

test('EMA 5/9 scalp: an arrow at every 1-minute EMA 5 / EMA 9 crossover, exactly where the lines cross', async () => {
  const { emaScalpSignals, emaScalpMarkers, EMA_SCALP } = await import('../../web/js/pages/scalper-chart-signals.js');
  assert.deepEqual([EMA_SCALP.fast, EMA_SCALP.slow, EMA_SCALP.rsiOn], [5, 9, false]);
  const t0 = Date.parse('2026-10-22T10:00:00+05:30') / 1000;
  // A gentle rise (EMA 5 over EMA 9), then a fall (EMA 5 under EMA 9: PE), then a rise again (CE).
  const closes = [...Array.from({ length: 20 }, (_, i) => 95 + i * 0.25), 99, 98, 97, 96, 95, 95, 96, 97, 98, 99, 100, 101, 102];
  const rows = closes.map((c, i) => ({ time: t0 + i * 60, open: c, high: c + 0.2, low: c - 0.2, close: c }));
  const later = (t0 + 60 * 60) * 1000;
  const s = emaScalpSignals(rows, { intervalMs: 60_000, now: later });
  // Reference crossings from the EMA 5 / EMA 9 lines themselves
  const ema = n => { const k = 2 / (n + 1); let v; return closes.map(c => (v = v == null ? c : c * k + v * (1 - k))); };
  const f = ema(5), w = ema(9), want = [];
  for (let i = 1; i < closes.length; i++) { const a = Math.sign(f[i - 1] - w[i - 1]), b = Math.sign(f[i] - w[i]); if (a && b && a !== b) want.push([rows[i].time, b > 0 ? 'CE' : 'PE']); }
  assert.deepEqual(s.map(x => [x.time, x.direction]), want);
  assert.deepEqual(want.map(x => x[1]), ['PE', 'CE']);
  assert.ok(s.every(x => x.ok), 'no RSI filter: every crossover is an entry');
  assert.deepEqual(emaScalpMarkers(s, 'spot').map(m => m.text), ['PE · EMA 5/9', 'CE · EMA 5/9']);
  assert.deepEqual(emaScalpMarkers(s, 'ce').map(m => m.text), ['BUY CE · EMA 5/9']);
  assert.deepEqual(emaScalpSignals(rows, { intervalMs: 300_000, now: later }), [], '1-minute chart only');
});

