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

const inr = n => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const price = n => (Number.isFinite(Number(n)) && n !== null ? Number(n).toFixed(2) : '—');
const time = n => n ? new Date(n).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';

// The strategies Algo Trading can run (descriptions shared with the Strategy page): every one for administrators,
// the public Gap card for other users (server: lib/access.js).
const isAdmin = () => !!store.get().user?.admin;
const strategies = () => builtInFor(isAdmin()).filter(s => s.auto);

const STATUS = { open: ['Open', ''], closing: ['Exiting', 'ice'], closed: ['Closed', 'grey'], skipped: ['Skipped', 'amber'], failed: ['Failed', 'red'], placing: ['Placing', 'ice'] };

/** Inside the Gap retest row: its retest window and stop, saved as they change. */
function retestRow(a) {
  const c = a?.retestCfg || { windowMin: 15, slPct: 3 };
  return html`
    <div class="algo-strat-head algo-strat-sub algo-retest-cfg">
      <span class="algo-strat-name"><b>Paper settings</b><small>Simulated fills on live prices; no order goes to Dhan.</small></span>
      <label>Window <input class="input" type="number" min="1" max="60" step="1" value="${c.windowMin}" data-retest-cfg="windowMin" aria-label="Retest window in minutes" ${a ? '' : 'disabled'}> min</label>
      <label>Stop <input class="input" type="number" min="0.5" max="50" step="0.5" value="${c.slPct}" data-retest-cfg="slPct" aria-label="Stop-loss percent below the entry" ${a ? '' : 'disabled'}> %</label>
    </div>`;
}

/** Paper trades (Gap retest 09:15): each day's simulated trade with its P&L after charges, and the totals. */
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
        : html`<p class="muted small" style="margin:0">No paper trades yet. Switch on Gap retest 09:15 above; it runs from the next 09:15.</p>`}
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
            <td class="num">${t.day}</td><td class="num">${time(t.createdAt)}</td><td>${t.strategy || 'ORB 5m'} · ${t.direction}${t.paper ? html` <span class="pill sm ice">Paper</span>` : ''}</td><td>${t.symbol || '—'}</td>
            <td class="num">${t.lots ?? '—'}</td><td class="num">${price(t.entryPrice)}</td><td class="num">${price(t.exitPrice)}</td>
            <td class="num ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${t.pnl == null ? '—' : money(t.pnl)}</td>
            <td class="num ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${t.pnlPct == null ? '—' : `${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`}</td>
            <td><span class="pill sm ${tone}" title="${t.reason || ''}">${label}</span>${t.reason ? html`<small class="algo-reason">${t.reason}</small>` : ''}</td></tr>`; })}</tbody></table></div>`
        : html`<p class="muted small" style="margin:0">No automatic trades on earlier days yet.</p>`}
    </section>`;
}

// Compact row: name, tag, ⓘ for the full rules, on/off switch.
function strategyRow(s, a, open, rules) {
  const on_ = !!a?.[s.flag];
  return html`
    <div class="algo-strat ${on_ ? 'on' : ''}">
      <div class="algo-strat-head">
        <span class="algo-strat-name"><b>${s.name}${s.paper ? html` <span class="pill sm ice">Paper</span>` : ''}</b><small>${s.tag} · ${s.timeframe}</small></span>
        ${s.public ? '' : raw(artInfo(s.key, s.name))}
        <button class="switch" type="button" role="switch" aria-checked="${String(on_)}" aria-label="${s.name}" data-strategy-toggle="${s.key}" ${a ? '' : 'disabled'}></button>
      </div>
      ${s.key === 'gap' ? gapLockRow(a, rules) : ''}
      ${s.key === 'gapRetest' ? retestRow(a) : ''}
    </div>`;
}

/** Inside the Gap open 09:15 row: the kill switch on a day the strategy has no entry. */
function gapLockRow(a, rules) {
  const on_ = !!a?.gapLockOn;
  return html`
    <div class="algo-strat-head algo-strat-sub">
      <span class="algo-strat-name"><b>Kill switch if no entry</b><small>${on_
        ? 'No Gap entry today (no gap, skipped or not filled): the Dhan kill switch locks trading for the rest of the day.'
        : 'Off: a day without a Gap entry leaves the account open for trading.'}${on_ && !rules?.killSwitch
        ? html` <span class="warn">Needs the kill switch on in <a href="/rules" data-nav="rules">Risk rules</a>.</span>` : ''}</small></span>
      <button class="switch" type="button" role="switch" aria-checked="${String(on_)}" aria-label="Kill switch on a day without a Gap open 09:15 entry" data-gap-lock-toggle ${a ? '' : 'disabled'}></button>
    </div>`;
}

export default {
  title: 'AI Algo Trading',
  sub: 'Automatic index option entries on your Dhan account',
  layout: 'app',
  auth: true,

  load: () => get('/algo/live'),

  view(ctx) {
    const d = ctx.data, a = d.account, running = !!a?.algoOn;
    const missing = d.readiness.filter(r => !r.ok);
    const admin = isAdmin(), STRATEGIES = strategies();
    const state = running ? (d.marketOpen ? ['Running', admin ? 'Watching every 5-minute close for signals' : 'Watching the market'] : ['On', 'Starts watching at the next market open'])
      : d.ready ? ['Stopped', 'No automatic orders are placed'] : ['Setup needed', `${missing.length} item${missing.length > 1 ? 's' : ''} below`];
    const activeStrats = STRATEGIES.filter(s => a?.[s.flag]).map(s => s.name), index = (d.underlyings || []).filter(u => (a?.underlyings || ['NIFTY']).includes(u.key)).map(u => u.label).join(' + ') || 'NIFTY 50';
    return html`
      <section class="panel pad algo-control ${running ? 'running' : ''}">
        <div class="algo-control-copy">
          <span class="pill ${running ? '' : 'ice'}"><span class="dot ${running && d.marketOpen ? 'pulse' : ''}"></span>${state[0]}</span>
          <h2>Algo Trading${a?.paperMode ? html` <span class="pill ice">Paper</span>` : ''}</h2>
          <p>${state[1]}. Trading <b>${index}</b> options · ${activeStrats.length ? html`strategies on: <b>${activeStrats.join(' + ')}</b>.` : html`<b>no strategy is on</b>: switch one on below.`}</p>
          ${a?.paperMode ? html`<p class="small algo-paper-note">Paper: trades fill at live Dhan prices with the <a href="/wallet" data-nav="wallet">paper wallet</a>'s money. No order goes to Dhan, and TradeLock is not watching your Dhan account until you switch back to Real.</p>` : ''}
        </div>
        <div class="seg algo-mode" role="group" aria-label="Real or paper trading">
          <button type="button" data-paper-mode="real" aria-pressed="${!a?.paperMode}" ${a ? '' : 'disabled'}>Real</button>
          <button type="button" data-paper-mode="paper" aria-pressed="${!!a?.paperMode}" ${a ? '' : 'disabled'}>Paper</button>
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
        <div class="panel kpi"><span class="lbl">SL left for the next trade</span><b class="num ${d.budget.left > 0 ? '' : 'neg'}">${inr(d.budget.left)}</b><small>Today’s P&L ${inr(d.budget.pnl)}</small></div>
        <div class="panel kpi"><span class="lbl">Automatic trades today</span><b class="num">${d.trades.filter(t => t.entryPrice != null).length}</b><small>${d.rules.tradeCap ? `Trade cap ${d.rules.tradeCap}` : 'No trade cap'}</small></div>
        <div class="panel kpi"><span class="lbl">Square-off</span><b class="num">${d.rules.squareOff}</b><small>${d.rules.locked ? 'Account locked for today' : d.rules.cutoff ? 'Your Risk rules cutoff' : 'Default (cutoff off)'}</small></div>
      </div>

      <div class="halves algo-setup-row">
        <div class="algo-left">
        <section class="panel pad">
          <h3 class="panel-title">Indices to trade</h3>
          <div class="algo-index" role="group" aria-label="Indices to trade">${(d.underlyings || []).map(u => { const on_ = (a?.underlyings || ['NIFTY']).includes(u.key); return html`
            <label class="algo-index-item ${on_ ? 'on' : ''}"><input type="checkbox" data-algo-index="${u.key}" ${on_ ? 'checked' : ''} ${a ? '' : 'disabled'}><span>${u.label}</span></label>`; })}</div>
          <p class="muted small algo-index-note">${admin ? 'Each ticked index is watched on its own 5-minute chart; a signal buys that index’s ATM next-expiry option. Still one trade at a time, sharing the day’s stop-loss.'
            : 'Each ticked index is traded on its own. Still one trade at a time, sharing the day’s stop-loss.'}</p>
        </section>
        <section class="panel pad algo-manual-card">
          <div class="algo-strat algo-manual ${a?.manualOn ? 'on' : ''}">
            <div class="algo-strat-head">
              <span class="algo-strat-name"><b>Manual trades</b><small>${a?.manualOn ? 'Allowed alongside Algo Trading. A manual position still counts as the one trade at a time and uses the day’s stop-loss.' : 'Blocked while Algo Trading is on: manual orders are refused and manual positions closed.'} On or off at any time.</small></span>
              <button class="switch" type="button" role="switch" aria-checked="${String(!!a?.manualOn)}" aria-label="Allow manual trades while Algo Trading is on" data-manual-toggle ${a ? '' : 'disabled'}></button>
            </div>
          </div>
        </section>
        </div>
        <section class="panel pad">
          <h3 class="panel-title">Strategies <a class="algo-strat-link" href="/strategy" data-nav="strategy">All strategies ${icon('arrow')}</a></h3>
          <div class="algo-strat-list">${STRATEGIES.map(s => strategyRow(s, a, !!ctx.ui.info?.[s.key], d.rules))}</div>
        </section>
      </div>

      <section class="panel pad algo-block algo-shared">
        <h3 class="panel-title">Every automatic trade</h3>
        <dl class="algo-rules">${sharedRulesFor(admin).map(([k, v]) => html`<dt>${k}</dt><dd>${v}${k === 'Phone alarm' && window.TradeLockApp?.testTradeAlarm ? html` <button class="btn btn-sm" type="button" data-alarm-test-algo>Test alarm</button>` : ''}</dd>`)}</dl>
      </section>

      <section class="panel pad algo-block">
        <h3 class="panel-title">Today</h3>
        ${d.trades.length ? html`<div class="bt-table-wrap"><table class="bt-table algo-trades">
          <thead><tr><th>Time</th><th>Signal</th><th>Contract</th><th>Lots</th><th>Entry</th><th>SL</th><th>Exit</th><th>Status</th></tr></thead>
          <tbody>${d.trades.map(t => { const [label, tone] = STATUS[t.status] || [t.status, '']; return html`<tr>
            <td class="num">${time(t.createdAt)}</td><td>${t.strategy || 'ORB 5m'} · ${t.direction}${t.paper ? html` <span class="pill sm ice">Paper</span>` : ''}</td><td>${t.symbol || '—'}</td>
            <td class="num">${t.lots ?? '—'}</td><td class="num">${price(t.entryPrice)}</td><td class="num">${price(t.slPrice)}</td><td class="num">${price(t.exitPrice)}</td>
            <td><span class="pill sm ${tone}" title="${t.reason || ''}">${label}</span>${t.reason ? html`<small class="algo-reason">${t.reason}</small>` : ''}</td></tr>`; })}</tbody></table></div>`
          : html`<p class="muted small" style="margin:0">No automatic trades yet today.</p>`}
      </section>
      ${historySection(d.history || [])}
      ${isAdmin() ? paperSection(d.paper || []) : ''}`;
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
    // A repaint would close a strategy picture someone is looking at; that refresh waits for the next round.
    const refresh = async () => { try { const d = await get('/algo/live'); if (el.querySelector('.sart-anchor.open, .sart-anchor:focus-within, .sart-anchor:hover')) return; ctx.data = d; ctx.paint(); } catch { /* keep the last view */ } };
    const timer = setInterval(refresh, 15_000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
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

    on(el, 'change', '[data-algo-index]', async (_, box) => {
      const id = ctx.data.account?.id;
      if (!id) return;
      const picked = [...el.querySelectorAll('[data-algo-index]')].filter(x => x.checked).map(x => x.dataset.algoIndex);
      if (!picked.length) { box.checked = true; toast('Keep at least one index ticked.', 'warn'); return; }
      el.querySelectorAll('[data-algo-index]').forEach(x => { x.disabled = true; });
      try {
        const { account } = await post(`/brokers/${id}/strategies`, { underlyings: picked });
        syncTopbar(account);
        const names = (ctx.data.underlyings || []).filter(u => picked.includes(u.key)).map(u => u.label);
        toast(`Algo Trading watches ${names.join(' + ')}.`, 'ok');
        await refresh();
      } catch (err) { toastError(err); await refresh(); }
    }, signal);

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

    // Real | Paper: which account Algo Trading trades (only with nothing open; the server checks).
    on(el, 'click', '[data-paper-mode]', async (_, b) => {
      const id = ctx.data.account?.id, on_ = b.dataset.paperMode === 'paper';
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

    on(el, 'click', '[data-gap-lock-toggle]', async (_, b) => {
      const id = ctx.data.account?.id, next = b.getAttribute('aria-checked') !== 'true';
      if (!id) return;
      b.disabled = true;
      try {
        const { account } = await post(`/brokers/${id}/strategies`, { gapLock: next });
        syncTopbar(account);
        toast(next ? 'The kill switch locks the day when Gap open 09:15 has no entry.' : 'A day without a Gap entry no longer locks the account.', 'ok');
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
