// AI Algo Trading: live automatic NIFTY option entries on the user's Dhan account (server: scalper/autotrade.js).
// One Start / Stop button, each strategy explained with its own on/off switch, today's SL budget and trades.
import { html, $, on } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';
import { builtInFor, sharedRulesFor } from './strategy-library.js';
import { artInfo } from './strategy-art.js';
import { confirmAlgoStart, noticeDialog } from '../ui/dialog.js';
import { raw } from '../core/dom.js';
import { rulesPanel, bindRules, editableSet, ruleSetNow } from './rules.js';

const inr = n => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const price = n => (Number.isFinite(Number(n)) && n !== null ? Number(n).toFixed(2) : '—');
const time = n => n ? new Date(n).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';

// The strategies Algo Trading can run (descriptions shared with the Strategy page): every one for administrators,
// the public Gap card for other users (server: lib/access.js).
const isAdmin = () => !!store.get().user?.admin;
const strategies = () => builtInFor(isAdmin()).filter(s => s.auto);

const STATUS = { open: ['Open', ''], closing: ['Exiting', 'ice'], closed: ['Closed', 'grey'], skipped: ['Skipped', 'amber'], failed: ['Failed', 'red'], placing: ['Placing', 'ice'] };

/** Paper trades (Gap wick 09:15): each day's simulated trade with its P&L after charges, and the totals. */
function paperSection(rows) {
  const traded = rows.filter(t => t.pnl != null), wins = traded.filter(t => t.pnl > 0).length, total = traded.reduce((a, t) => a + t.pnl, 0);
  const money = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  const PAPER = { watching: ['Waiting', 'ice'], open: ['Open', ''], closed: ['Closed', 'grey'], skipped: ['No trade', 'amber'] };
  return html`
    <section class="panel pad algo-block">
      <h3 class="panel-title">Paper trades <span class="pill sm ice">No orders</span></h3>
      ${rows.length ? html`
        <p class="muted small algo-history-sum">${traded.length} trade${traded.length === 1 ? '' : 's'} · ${wins} won · P&amp;L <b class="${total >= 0 ? 'pos' : 'neg'}">${money(total)}</b> after charges · ${rows.length - traded.length} day${rows.length - traded.length === 1 ? '' : 's'} without a trade</p>
        <div class="bt-table-wrap"><table class="bt-table algo-trades">
          <thead><tr><th>Date</th><th>Strategy</th><th>Contract</th><th>Lots</th><th>Waits for</th><th>Entry</th><th>Stop</th><th>Exit</th><th>P&amp;L</th><th>Status</th></tr></thead>
          <tbody>${rows.map(t => { const [label, tone] = PAPER[t.status] || [t.status, '']; return html`<tr>
            <td class="num">${t.day}</td><td>${t.strategy}${t.direction ? ` · ${t.direction}` : ''}</td><td>${t.symbol || '—'}</td><td class="num">${t.lots ?? '—'}</td>
            <td class="num">${price(t.level)}</td><td class="num">${price(t.entryPrice)}</td><td class="num">${price(t.slPrice)}</td><td class="num">${price(t.exitPrice)}</td>
            <td class="num ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${t.pnl == null ? '—' : money(t.pnl)}</td>
            <td><span class="pill sm ${tone}">${label}</span>${t.reason ? html`<small class="algo-reason">${t.reason}</small>` : ''}</td></tr>`; })}</tbody></table></div>`
        : html`<p class="muted small" style="margin:0">No paper trades yet. Switch on Gap wick 09:15 above and start Algo Trading; it runs from the next 09:15.</p>`}
    </section>`;
}

/** Earlier days' automatic trades: one row each, with its P&L (before charges), and the totals of the traded ones. */
function historySection(rows) {
  const traded = rows.filter(t => t.pnl != null && !t.paper), wins = traded.filter(t => t.pnl > 0).length;   // real money only; paper trades are marked
  const total = traded.reduce((a, t) => a + t.pnl, 0), used = traded.reduce((a, t) => a + t.entryPrice * t.qty, 0);
  const money = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  return html`
    <section class="panel pad algo-block">
      <h3 class="panel-title">History</h3>
      ${rows.length ? html`
        <p class="muted small algo-history-sum">Real money: ${traded.length} trade${traded.length === 1 ? '' : 's'} · ${wins} won · P&amp;L <b class="${total >= 0 ? 'pos' : 'neg'}">${money(total)}</b>${used ? ` (${(total / used * 100).toFixed(1)}% of the capital used)` : ''} · before charges${rows.some(t => t.paper) ? ` · paper trades are marked Paper and not counted` : ''}</p>
        <div class="bt-table-wrap"><table class="bt-table algo-trades">
          <thead><tr><th>Date</th><th>Time</th><th>Signal</th><th>Contract</th><th>Lots</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>%</th><th>Status</th></tr></thead>
          <tbody>${rows.map(t => { const [label, tone] = STATUS[t.status] || [t.status, '']; return html`<tr>
            <td class="num">${t.day}</td><td class="num">${time(t.createdAt)}</td><td>${t.strategy || 'ORB 5m'} · ${INDEX_SHORT[t.underlying] || 'NIFTY 50'} · ${t.direction}${t.paper ? html` <span class="pill sm ice">Paper</span>` : ''}</td><td>${t.symbol || '—'}</td>
            <td class="num">${t.lots ?? '—'}</td><td class="num">${price(t.entryPrice)}</td><td class="num">${price(t.exitPrice)}</td>
            <td class="num ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${t.pnl == null ? '—' : money(t.pnl)}</td>
            <td class="num ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${t.pnlPct == null ? '—' : `${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`}</td>
            <td><span class="pill sm ${tone}" title="${t.reason || ''}">${label}</span>${t.reason ? html`<small class="algo-reason">${t.reason}</small>` : ''}</td></tr>`; })}</tbody></table></div>`
        : html`<p class="muted small" style="margin:0">No automatic trades on earlier days yet.</p>`}
    </section>`;
}

// Strategy page key → the Algo Trading grid's key (server: scalper/algo-grid.js).
const GRID_KEY = { orb: 'orb', emaCross: 'ema59', ema915: 'ema915', gap: 'gap', strangle: 'strangle' };
const INDEX_SHORT = { NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY', SENSEX: 'SENSEX' };
const LIVE = ['placing', 'open', 'closing'];

/** One grid cell: the switch for a strategy on an index, and what it is doing today. */
function gridCell(s, U, a, trades) {
  const g = GRID_KEY[s.key], cell = a?.grid?.[g]?.[U], on_ = !!cell?.on, name = a?.gridStrategies?.find(x => x.key === g)?.name;
  const mine = trades.filter(t => t.strategy === name && (t.underlying || 'NIFTY') === U);
  const live = mine.some(t => LIVE.includes(t.status)), done = mine.some(t => t.entryPrice != null);
  return html`<div class="algo-cell ${on_ ? 'on' : ''}" role="cell">
    <span class="algo-cell-index">${INDEX_SHORT[U]}</span>
    <button class="switch" type="button" role="switch" aria-checked="${String(on_)}" aria-label="${s.name} on ${INDEX_SHORT[U]}" data-grid-toggle="${g}|${U}" ${a ? '' : 'disabled'}></button>
    ${live ? html`<span class="pill sm algo-cell-state">In trade</span>` : done ? html`<span class="pill sm grey algo-cell-state">Traded</span>` : ''}
  </div>`;
}

/** A grid row: the strategy (ⓘ for its rules) and a switch per index; its own settings below. */
function gridRow(s, a, trades, rules) {
  const g = GRID_KEY[s.key], onAt = (a?.grid ? Object.entries(a.grid[g] || {}) : []).filter(([, c]) => c.on).map(([U]) => U);
  return html`
    <div class="algo-strat algo-grid-row ${onAt.length ? 'on' : ''}">
      <div class="algo-grid-line">
        <span class="algo-strat-name"><b>${s.name}</b><small>${s.tag} · ${s.timeframe}</small></span>
        ${s.public ? '' : raw(artInfo(s.key, s.name))}
        <div class="algo-cells" role="row">${['NIFTY', 'BANKNIFTY', 'SENSEX'].map(U => gridCell(s, U, a, trades))}</div>
      </div>
      ${s.key === 'gap' ? onAt.map(U => gapSettings(a, U, rules)) : ''}
      ${s.key === 'strangle' ? onAt.map(U => strangleSettings(a, rules, U)) : ''}
    </div>`;
}

// Compact row (strategies outside the grid, e.g. the Gap wick paper trades): name, tag, ⓘ, on/off switch.
function strategyRow(s, a, open, rules) {
  const on_ = !!a?.[s.flag];
  return html`
    <div class="algo-strat ${on_ ? 'on' : ''}">
      <div class="algo-strat-head">
        <span class="algo-strat-name"><b>${s.name}</b><small>${s.tag} · ${s.timeframe}</small></span>
        ${s.public ? '' : raw(artInfo(s.key, s.name))}
        <button class="switch" type="button" role="switch" aria-checked="${String(on_)}" aria-label="${s.name}" data-strategy-toggle="${s.key}" ${a ? '' : 'disabled'}></button>
      </div>

      ${s.key === 'strangle' ? strangleSettings(a, rules) : ''}
    </div>`;
}

/** Capital: a fixed ₹ amount or a % of the funds available at the entry (the dropdown), and its value box. */
function capitalFields(attr, c, dis, zeroText) {
  const pct = c.capitalMode === 'percent';
  return html`
    <label class="algo-strangle-field"><span>Capital in</span><select class="input" ${raw(`${attr}="capitalMode"`)} ${dis}>
      <option value="amount" ${pct ? '' : 'selected'}>₹ fixed amount</option><option value="percent" ${pct ? 'selected' : ''}>% of available funds</option></select></label>
    <label class="algo-strangle-field"><span>${pct ? 'Capital % of available funds' : `Capital ₹ (${zeroText})`}</span><input class="input" type="number" min="${pct ? 1 : 0}" max="${pct ? 100 : 1e9}" step="${pct ? 1 : 1000}" ${raw(`${attr}="capitalValue"`)} value="${pct ? c.capitalPct : c.capital}" ${dis}></label>`;
}
/** The capital fields' values for a save: the value box sets the chosen mode's number; the other one is kept. */
function capitalFrom(box, attr, cur) {
  if (!box.querySelector(`[${attr}="capitalMode"]`)) return { capitalMode: cur.capitalMode || 'amount', capital: Number(cur.capital || 0), capitalPct: Number(cur.capitalPct || 80) };   // hidden (fixed lots): kept
  const mode = box.querySelector(`[${attr}="capitalMode"]`)?.value || 'amount', v = Number(box.querySelector(`[${attr}="capitalValue"]`)?.value || 0);
  const same = mode === (cur.capitalMode || 'amount');   // a changed mode keeps both numbers; the box shows the other one next
  return { capitalMode: mode, capital: same && mode === 'amount' ? v : Number(cur.capital || 0), capitalPct: same && mode === 'percent' ? v : Number(cur.capitalPct || (attr === 'data-gap-cfg' ? 80 : 100)) };
}
const money = n => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/** Inside the CE + PE row: one index's settings, saved together when any of them changes. */
function strangleSettings(a, rules, U = 'NIFTY') {
  const cell = a?.grid?.strangle?.[U] || {}, c = cell.cfg || a?.strangleCfg || {}, dis = a ? '' : 'disabled', pct = c.capitalMode === 'percent';
  const f = (k, label, type, min, max, step = '1') => html`<label class="algo-strangle-field"><span>${label}</span><input class="input" type="${type}" min="${min}" max="${max}" step="${step}" data-strangle-cfg="${k}" value="${c[k] ?? ''}" ${dis}></label>`;
  return html`
    <div class="algo-strat-sub algo-strangle" data-strangle-index="${U}">
      <b class="algo-strangle-title">${INDEX_SHORT[U]}</b>
      ${capitalFields('data-strangle-cfg', c, dis, '0 = all available funds')}
      ${f('target', 'Option price ₹', 'number', 0.05, 5000, '0.05')}
      ${f('bandPct', 'Price band ± %', 'number', 1, 95)}
      ${f('entry', 'Entry', 'time', '09:15', '15:29', '60')}
      ${f('waitMin', 'Wait (min)', 'number', 0, 120)}
      ${f('exit', 'Exit', 'time', '09:16', '15:29', '60')}
      ${f('stopPct', 'Stop % (minute close)', 'number', 1, 99)}
      ${f('maxVolPct', 'Max % of volume (0 = off)', 'number', 0, 100)}
      <label class="algo-strangle-field"><span>On the expiry day</span><select class="input" data-strangle-cfg="expiryDay" ${dis}>${[['next', 'Next expiry'], ['skip', 'Skip the day'], ['next1', 'Next expiry from the day before']].map(([v, t]) => html`<option value="${v}" ${(c.expiryDay || 'next') === v ? 'selected' : ''}>${t}</option>`)}</select></label>
      <small class="muted">${pct ? `Each trade uses ${c.capitalPct}% of the funds available at the entry` : c.capital > 0 ? `Each trade uses ${money(c.capital)}` : `Each trade uses all the available funds`}, within the funds and your Risk rules capital per trade. ${rules?.cutoff && rules.cutoff < (c.exit || '15:25') ? `Your Risk rules cutoff ${rules.cutoff} comes first, so it sells at ${rules.cutoff}. ` : ''}Real money when Algo Trading is on Real.</small>
    </div>`;
}

/** Inside the Gap open 09:15 row: one index's settings (as the Gap backtest's inputs), saved together when one changes. */
function gapSettings(a, U, rules) {
  const cell = a?.grid?.gap?.[U] || {}, c = cell.cfg || {}, dis = a ? '' : 'disabled', pct = c.capitalMode === 'percent';
  const num = (k, label, min, max, step = '1') => html`<label class="algo-strangle-field"><span>${label}</span><input class="input" type="number" min="${min}" max="${max}" step="${step}" data-gap-cfg="${k}" value="${c[k] ?? ''}" ${dis}></label>`;
  const pick = (k, label, yes, no) => html`<label class="algo-strangle-field"><span>${label}</span><select class="input" data-gap-cfg="${k}" ${dis}><option value="1" ${c[k] ? 'selected' : ''}>${yes}</option><option value="0" ${c[k] ? '' : 'selected'}>${no}</option></select></label>`;
  return html`
    <div class="algo-strat-sub algo-strangle" data-gap-index="${U}">
      <b class="algo-strangle-title">${INDEX_SHORT[U]}</b>
      <label class="algo-strangle-field"><span>Decide the side</span><select class="input" data-gap-cfg="decide" ${dis}>${[['premium', 'ATM premium at 09:15 (backtested)'], ['preopen', 'Index pre-open, order at 09:15:00']].map(([v, t]) => html`<option value="${v}" ${(c.decide || 'premium') === v ? 'selected' : ''}>${t}</option>`)}</select></label>
      ${num('lots', 'Fixed lots (0 = from capital)', 0, 500)}
      ${c.lots > 0 ? '' : capitalFields('data-gap-cfg', c, dis, '0 = Risk rules / funds')}
      ${num('stopPct', c.lots > 0 ? 'Stop-loss % of the premium paid' : 'Stop-loss % of capital', 0, 100, '0.5')}
      ${pick('costToCost', 'Cost to cost at 1R', 'On', 'Off')}
      ${pick('requireGreen', 'Premium green in the first seconds', 'Required', 'Not required')}
      ${pick('autoExit', 'Exit at 09:16', 'Yes, sell at 09:16:00', `No: stop, your exit or ${rules?.squareOff || '15:15'}`)}
      ${pick('noEntryLock', 'If no Gap entry today', 'Kill switch: lock the day', 'Leave the account open')}
      <small class="muted">${c.decide === 'preopen' ? 'Side from the index pre-open (09:00–09:08 auction) vs its previous close: up → CE, down → PE, decided at 09:14:30; the buy goes at 09:15:00 (a limit at the estimated premium + 15%, then market orders each second if not filled). The green rule does not apply. ' : ''}${c.lots > 0 ? `Each trade buys ${c.lots} lot${c.lots > 1 ? 's' : ''} (the funds must cover them).` : `${pct ? `Each trade uses ${c.capitalPct}% of the funds available at 09:15` : c.capital > 0 ? `Each trade uses ${money(c.capital)}` : `Each trade uses your Risk rules capital per trade, or ${c.fundsPct ?? 80}% of the funds`}, within the funds and your Risk rules capital per trade.`} ${c.stopPct > 0 ? (c.lots > 0 ? `Stop-loss ${c.stopPct}% below the fill price.` : `Stop-loss ${c.stopPct}% of that capital, spread over the quantity.`) : html`<span class="warn">Set a stop-loss %: at 0 the stop comes from the Algo Trading daily stop-loss, and with that off Gap does not trade.</span>`} ${c.decide === 'preopen' ? 'Strike ITM3 from the pre-open ATM (one deeper: the index often moves back in the first seconds). ' : 'Strike ITM2. '}${c.noEntryLock && !rules?.killSwitch ? html`<span class="warn">“Kill switch: lock the day” needs the Algo Trading kill switch rule on.</span> ` : ''}${c.decide === 'preopen' ? '' : 'The live order is bought in the first seconds after 09:15, so “green” can only be checked then, not on the whole first minute.'}</small>
    </div>`;
}

export default {
  title: 'AI Algo Trading',
  sub: 'Automatic index option entries on your Dhan account',
  layout: 'app',
  auth: true,

  // Paper is the default: with no broker connected, opening the page sets up the Paper account (₹10 lakh paper wallet,
  // shared market data), so strategies can be switched on and Algo Trading started on paper at once.
  async load(ctx) {
    // Other users edit their Algo Trading risk rules here; administrators size each strategy from its own settings.
    const rules = isAdmin() ? null : await get('/rules').catch(() => null);
    ctx.ui.algoRules = rules ? { set: 'algo', form: editableSet(rules, 'algo'), error: null, pending: rules.pending ? rules.pendingFrom : null, mode: rules.mode } : null;
    const d = await get('/algo/live');
    if (d.account) return d;
    try { await post('/paper/account'); return await get('/algo/live'); } catch { return d; }
  },

  view(ctx) {
    const d = ctx.data, a = d.account, running = !!a?.algoOn;
    const missing = d.readiness.filter(r => !r.ok);
    const admin = isAdmin(), STRATEGIES = strategies();
    const state = running ? (d.marketOpen ? ['Running', admin ? 'Watching every 5-minute close for signals' : 'Watching the market'] : ['On', 'Starts watching at the next market open'])
      : d.ready ? ['Stopped', 'No automatic orders are placed'] : ['Setup needed', `${missing.length} item${missing.length > 1 ? 's' : ''} below`];
    // "CE + PE at a target price (NIFTY 50, SENSEX)": each strategy with the indices it is on for.
    const activeStrats = STRATEGIES.map(s => {
      const g = GRID_KEY[s.key];
      if (!g) return a?.[s.flag] ? s.name : null;
      const at = Object.entries(a?.grid?.[g] || {}).filter(([, c]) => c.on).map(([U]) => INDEX_SHORT[U]);
      return at.length ? `${s.name} (${at.join(', ')})` : null;
    }).filter(Boolean);
    const gridStrats = STRATEGIES.filter(s => GRID_KEY[s.key]), otherStrats = STRATEGIES.filter(s => !GRID_KEY[s.key]);
    return html`
      <section class="panel pad algo-control ${running ? 'running' : ''}">
        <div class="algo-control-copy">
          <span class="pill ${running ? '' : 'ice'}"><span class="dot ${running && d.marketOpen ? 'pulse' : ''}"></span>${state[0]}</span>
          <h2>Algo Trading${a?.paperMode ? html` <span class="pill ice">Paper</span>` : ''}</h2>
          <p>${state[1]}. ${activeStrats.length ? html`On: <b>${activeStrats.join(' · ')}</b>.` : html`<b>No strategy is on</b>: switch one on for an index below.`}</p>
          ${a?.paperMode ? html`<p class="small algo-paper-note">Paper: trades fill at live Dhan prices with the <a href="/wallet" data-nav="wallet">paper wallet</a>'s money. No order goes to Dhan, and TradeLock is not watching your Dhan account until you switch back to Real.</p>` : ''}
        </div>
        <div class="seg algo-mode" role="group" aria-label="Real or paper trading">
          <button type="button" data-paper-mode="paper" aria-pressed="${!a || !!a.paperMode}">Paper</button>
          <button type="button" data-paper-mode="real" aria-pressed="${!!a && !a.paperMode}" ${a && a.broker !== 'paper' ? '' : 'disabled title="Connect your Dhan account to trade with real money"'}>Real</button>
        </div>
        <button class="btn ${running ? 'btn-danger' : 'btn-primary'} algo-start" type="button" data-algo-start="${running ? 'stop' : 'start'}" ${!a || (!running && !d.ready) ? 'disabled' : ''}>
          ${icon(running ? 'stop' : 'play')}${running ? 'Stop Algo Trading' : 'Start Algo Trading'}</button>
      </section>

      ${missing.length ? html`
        <section class="panel pad algo-setup">
          <h3 class="panel-title">Before it can start</h3>
          ${d.readiness.map(r => html`<div class="algo-ready ${r.ok ? 'ok' : ''}">${icon(r.ok ? 'check' : 'alert')}<span><b>${r.label}</b><small>${r.detail}</small></span></div>`)}
        </section>` : ''}

      <div class="kpis algo-kpis">
        <div class="panel kpi"><span class="lbl">Day stop-loss</span><b class="num">${d.budget.daily ? inr(d.budget.daily) : 'Off'}</b><small>${d.budget.lossLimitMode === 'percent' ? `${d.budget.lossLimitValue}% of ${inr(d.budget.capital)}` : 'Fixed amount'}</small></div>
        <div class="panel kpi"><span class="lbl">SL left for the next trade</span><b class="num ${!d.budget.daily || d.budget.left > 0 ? '' : 'neg'}">${d.budget.daily ? inr(d.budget.left) : 'Off'}</b><small>Today’s P&L ${inr(d.budget.pnl)}</small></div>
        <div class="panel kpi"><span class="lbl">Automatic trades today</span><b class="num">${d.trades.filter(t => t.entryPrice != null).length}</b><small>${d.rules.tradeCap ? `Trade cap ${d.rules.tradeCap}` : 'No trade cap'}</small></div>
        <div class="panel kpi"><span class="lbl">Square-off</span><b class="num">${d.rules.squareOff}</b><small>${d.rules.locked ? 'Account locked for today' : d.rules.cutoff ? 'Your Risk rules cutoff' : 'Default (cutoff off)'}</small></div>
      </div>

      <section class="panel pad algo-grid-card">
        <h3 class="panel-title">Strategies × indices <a class="algo-strat-link" href="/strategy" data-nav="strategy">All strategies ${icon('arrow')}</a></h3>
        <p class="muted small algo-grid-note">Switch each strategy on for the indices it should trade. Every strategy holds one trade at a time per index, and different strategies and indices run side by side. ${admin ? 'Each one sizes its trades and stops from its own settings below.' : 'They share your Risk rules: the day’s loss limit, trade cap, cutoff and kill switch count all of them together.'} Funds go first come, first served.</p>
        <div class="algo-strat-list algo-grid" role="table" aria-label="Strategies by index">
          ${gridStrats.map(s => gridRow(s, a, d.trades || [], d.rules))}
          ${otherStrats.map(s => strategyRow(s, a, !!ctx.ui.info?.[s.key], d.rules))}
        </div>
      </section>

      <section class="panel pad algo-manual-card">
        <div class="algo-strat algo-manual ${a?.manualOn ? 'on' : ''}">
          <div class="algo-strat-head">
            <span class="algo-strat-name"><b>Manual trades</b><small>${a?.manualOn ? 'Allowed alongside Algo Trading. A manual position does not stop Algo entries; it uses the day’s loss limit and counts toward the trade cap.' : 'Blocked while Algo Trading is on: manual orders are refused and manual positions closed.'} On or off at any time.</small></span>
            <button class="switch" type="button" role="switch" aria-checked="${String(!!a?.manualOn)}" aria-label="Allow manual trades while Algo Trading is on" data-manual-toggle ${a ? '' : 'disabled'}></button>
          </div>
        </div>
      </section>


      ${ctx.ui.algoRules ? html`
      <section class="algo-rules-card" id="algo-rules">
        <h3 class="panel-title algo-rules-title">Risk rules for Algo Trading</h3>
        ${rulesPanel(ctx.ui.algoRules.form, { set: 'algo', now: ruleSetNow(ctx.state.dash, ctx.ui.algoRules.mode), capital: ctx.state.dash?.capital ?? d.budget?.capital, dash: ctx.state.dash, error: ctx.ui.algoRules.error, pending: ctx.ui.algoRules.pending })}
      </section>` : ''}

      <section class="panel pad algo-block algo-shared">
        <h3 class="panel-title">Every automatic trade</h3>
        <dl class="algo-rules">${sharedRulesFor(admin).map(([k, v]) => html`<dt>${k}</dt><dd>${v}${k === 'Phone alarm' && window.TradeLockApp?.testTradeAlarm ? html` <button class="btn btn-sm" type="button" data-alarm-test-algo>Test alarm</button>` : ''}</dd>`)}</dl>
      </section>

      <section class="panel pad algo-block">
        <h3 class="panel-title">Today</h3>
        ${d.trades.length ? html`<div class="bt-table-wrap"><table class="bt-table algo-trades">
          <thead><tr><th>Time</th><th>Signal</th><th>Contract</th><th>Lots</th><th>Entry</th><th>SL</th><th>Exit</th><th>Status</th></tr></thead>
          <tbody>${d.trades.map(t => { const [label, tone] = STATUS[t.status] || [t.status, '']; return html`<tr>
            <td class="num">${time(t.createdAt)}</td><td>${t.strategy || 'ORB 5m'} · ${INDEX_SHORT[t.underlying] || 'NIFTY 50'} · ${t.direction}${t.paper ? html` <span class="pill sm ice">Paper</span>` : ''}</td><td>${t.symbol || '—'}</td>
            <td class="num">${t.lots ?? '—'}</td><td class="num">${price(t.entryPrice)}</td><td class="num">${price(t.slPrice)}</td><td class="num">${price(t.exitPrice)}</td>
            <td><span class="pill sm ${tone}" title="${t.reason || ''}">${label}</span>${t.reason ? html`<small class="algo-reason">${t.reason}</small>` : ''}</td></tr>`; })}</tbody></table></div>`
          : html`<p class="muted small" style="margin:0">No automatic trades yet today.</p>`}
      </section>
      ${historySection(d.history || [])}
      ${paperSection(d.paper || [])}`;
  },

  // Follow the top-bar switch at once instead of waiting for the 15-second refresh.
  onStore(ctx, patch) {
    const b = patch.dash?.broker, a = ctx.data?.account;
    if (!b || !a || b.id !== a.id || !!b.algoOn === !!a.algoOn) return;
    ctx.data = { ...ctx.data, account: { ...a, algoOn: !!b.algoOn } };
    ctx.paint();
  },

  mount(ctx) {
    const { el, signal } = ctx;
    // A repaint would close a strategy picture someone is looking at, or drop the cursor from a rule value being typed;
    // that refresh waits for the next round.
    const refresh = async () => { try { const d = await get('/algo/live'); if (el.querySelector('.sart-anchor.open, .sart-anchor:focus-within, .sart-anchor:hover, [data-rules-set] input:focus')) return; ctx.data = d; ctx.paint(); } catch { /* keep the last view */ } };
    const timer = setInterval(refresh, 15_000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    if (ctx.ui.algoRules) bindRules(ctx, ctx.ui.algoRules, { capital: () => ctx.state.dash?.capital ?? ctx.data.budget?.capital, onSaved: () => refresh() });
    const syncTopbar = account => {
      const dash = store.get().dash;
      if (dash && account) store.set({ dash: { ...dash, broker: account } });
    };

    on(el, 'click', '[data-algo-start]', async (_, b) => {
      const start = b.dataset.algoStart === 'start', id = ctx.data.account?.id;
      if (!id) return;
      if (!start && store.get().dash?.algoLocked) {
        await noticeDialog({ ic: 'lock', tone: 'warn', title: 'Algo Trading stays on until 15:30', confirm: 'Got it',
          body: 'Algo Trading can’t be switched off during market hours (09:15–15:30 IST). Exits are always allowed: you can close an Algo trade yourself at any time.' });
        return;
      }
      if (start && !(await confirmAlgoStart())) return;
      // Flip the shared store first so this button and the top-bar switch change together; a refusal flips both back.
      const setOn = v => { const dash = store.get().dash; if (dash?.broker) store.set({ dash: { ...dash, broker: { ...dash.broker, algoOn: v } } }); };
      ctx.data = { ...ctx.data, account: { ...ctx.data.account, algoOn: start } };
      setOn(start); ctx.paint();
      try {
        const { account } = await post(`/brokers/${id}/algo`, { on: start });
        syncTopbar(account);
        toast(start ? 'Algo Trading started.' : 'Algo Trading stopped. An open trade keeps its stop-loss.', start ? 'warn' : 'ok');
        refresh();
      } catch (err) {
        ctx.data = { ...ctx.data, account: { ...ctx.data.account, algoOn: !start } };
        setOn(!start); ctx.paint(); toastError(err);
      }
    }, signal);

    // (i): the picture shows on hover; a tap (phones) pins it open, a tap elsewhere closes it.
    on(el, 'click', '[data-art-info]', (e, b) => {
      e.stopPropagation();
      const anchor = b.closest('.sart-anchor'), open = !anchor.classList.contains('open');
      el.querySelectorAll('.sart-anchor.open').forEach(a => a.classList.remove('open'));
      anchor.classList.toggle('open', open);
    }, signal);
    document.addEventListener('click', e => { if (!e.target.closest('.sart-anchor')) el.querySelectorAll('.sart-anchor.open').forEach(a => a.classList.remove('open')); }, { signal });

    // Android app: ring the real trade alarm once, to check sound, vibration and the full-screen alert.
    on(el, 'click', '[data-alarm-test-algo]', () => window.TradeLockApp?.testTradeAlarm?.(), signal);
    on(el, 'click', '[data-manual-toggle]', async (_, b) => {
      const id = ctx.data.account?.id, next = b.getAttribute('aria-checked') !== 'true';
      if (!id) return;
      b.disabled = true;
      try {
        const { account } = await post(`/brokers/${id}/strategies`, { manual: next });
        syncTopbar(account);
        toast(next ? 'Manual trades allowed alongside Algo Trading.' : 'Manual trades blocked while Algo Trading is on.', 'ok');
        await refresh();
      } catch (err) { toastError(err); b.disabled = false; }
    }, signal);

    // Paper | Real: which account Algo Trading trades (only with nothing open; the server checks). Without a broker,
    // Paper sets up a Paper account (prices from TradeLock's market data).
    on(el, 'click', '[data-paper-mode]', async (_, b) => {
      const id = ctx.data.account?.id, on_ = b.dataset.paperMode === 'paper';
      if (!id && on_) {
        b.disabled = true;
        try { const { account } = await post('/paper/account'); syncTopbar(account); toast('Paper trading is set up: ₹10,00,000 in the paper wallet. Switch on a strategy and Start Algo Trading.', 'ok'); await refresh(); }
        catch (err) { toastError(err); b.disabled = false; }
        return;
      }
      if (!id || !!ctx.data.account?.paperMode === on_) return;
      if (!on_ && !confirm('Switch Algo Trading back to REAL money on your Dhan account?')) return;
      b.disabled = true;
      try {
        const { account } = await post(`/brokers/${id}/paper`, { on: on_ });
        syncTopbar(account);
        toast(on_ ? 'Paper trading on: the paper wallet, live prices, no orders to Dhan.' : 'Real trading on: your Dhan account, real money.', on_ ? 'ok' : 'warn');
        await refresh();
      } catch (err) { toastError(err); b.disabled = false; }
    }, signal);

    // Gap retest (paper): window and stop are saved together when either changes.
    on(el, 'change', '[data-retest-cfg]', async () => {
      const id = ctx.data.account?.id;
      if (!id) return;
      const val = k => Number(el.querySelector(`[data-retest-cfg="${k}"]`)?.value);
      try {
        await post(`/brokers/${id}/strategies`, { retestCfg: { windowMin: val('windowMin'), slPct: val('slPct') } });
        toast('Paper settings saved.', 'ok');
        await refresh();
      } catch (err) { toastError(err); await refresh(); }
    }, signal);

    // CE + PE at a target price: one index's settings, saved together when one of them changes.
    on(el, 'change', '[data-strangle-cfg]', async (_, field) => {
      const id = ctx.data.account?.id, box = field.closest('[data-strangle-index]'), U = box?.dataset.strangleIndex;
      if (!id || !box) return;
      // A field hidden for the capital choice (% of funds: no Capital used % / compounding) keeps its saved value.
      const cur = ctx.data.account?.grid?.strangle?.[U]?.cfg || {}, val = k => box.querySelector(`[data-strangle-cfg="${k}"]`)?.value ?? (cur[k] == null ? undefined : String(cur[k] === true ? 1 : cur[k] === false ? 0 : cur[k]));
      const cfg = Object.fromEntries(['target', 'bandPct', 'waitMin', 'stopPct', 'fundsPct', 'maxVolPct'].map(k => [k, Number(val(k) || 0)]));
      try {
        await post(`/brokers/${id}/algo-grid`, { strategy: 'strangle', index: U, cfg: { ...cfg, ...capitalFrom(box, 'data-strangle-cfg', cur), entry: val('entry'), exit: val('exit'), expiryDay: val('expiryDay') || 'next', compound: val('compound') !== '0' } });
        toast(`CE + PE ${INDEX_SHORT[U]} settings saved.`, 'ok');
        await refresh();
      } catch (err) { toastError(err); await refresh(); }
    }, signal);

    // Gap open 09:15: one index's settings, saved together when one of them changes.
    on(el, 'change', '[data-gap-cfg]', async (_, field) => {
      const id = ctx.data.account?.id, box = field.closest('[data-gap-index]'), U = box?.dataset.gapIndex;
      if (!id || !box) return;
      const cur = ctx.data.account?.grid?.gap?.[U]?.cfg || {}, val = k => box.querySelector(`[data-gap-cfg="${k}"]`)?.value ?? (cur[k] == null ? undefined : String(cur[k] === true ? 1 : cur[k] === false ? 0 : cur[k]));
      const cfg = { ...capitalFrom(box, 'data-gap-cfg', cur), fundsPct: Number(val('fundsPct') || 80), stopPct: Number(val('stopPct') || 0), compound: val('compound') === '1',
        costToCost: val('costToCost') === '1', requireGreen: val('requireGreen') === '1', autoExit: val('autoExit') === '1', noEntryLock: val('noEntryLock') === '1',
        decide: val('decide') || 'premium', lots: Number(val('lots') || 0) };
      try {
        await post(`/brokers/${id}/algo-grid`, { strategy: 'gap', index: U, cfg });
        toast(`Gap open 09:15 ${INDEX_SHORT[U]} settings saved.`, 'ok');
        await refresh();
      } catch (err) { toastError(err); await refresh(); }
    }, signal);

    // The grid: one strategy on one index, on or off.
    on(el, 'click', '[data-grid-toggle]', async (_, b) => {
      const id = ctx.data.account?.id, [g, U] = b.dataset.gridToggle.split('|'), next = b.getAttribute('aria-checked') !== 'true';
      if (!id) return;
      b.disabled = true;
      try {
        const { account } = await post(`/brokers/${id}/algo-grid`, { strategy: g, index: U, on: next });
        syncTopbar(account);
        const name = ctx.data.account?.gridStrategies?.find(x => x.key === g)?.label || g;
        toast(`${name} ${next ? 'on' : 'off'} for ${INDEX_SHORT[U]}.`, next ? 'ok' : 'ok');
        await refresh();
      } catch (err) { toastError(err); b.disabled = false; }
    }, signal);

    on(el, 'click', '[data-strategy-toggle]', async (_, b) => {
      const id = ctx.data.account?.id, key = b.dataset.strategyToggle, next = b.getAttribute('aria-checked') !== 'true';
      if (!id) return;
      b.disabled = true;
      try {
        const { account } = await post(`/brokers/${id}/strategies`, { [key]: next });
        syncTopbar(account);
        const s = strategies().find(x => x.key === key);
        toast(`${s.name} ${next ? 'on' : 'off'}.`, 'ok');
        await refresh();
      } catch (err) { toastError(err); b.disabled = false; }
    }, signal);
  },
};
