import { html, on, busy } from '../core/dom.js';
import { get, post, del } from '../core/api.js';
import { inr, tone, price, duration, fmt12, longDay, axisInr, istNow, ago } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { pill, meter, empty, statusOf, toneClass } from '../ui/parts.js';
import { lineChart, ring, niceScale } from '../ui/charts.js';
import { toast, toastError } from '../ui/toast.js';
import { mountKillSwitch, ksOn } from '../ui/killswitch.js';
import { otherSl, otherTarget, pnlSplit } from './overview-sl.js';

const OPEN = 555, CLOSE = 930; // 09:15 – 15:30 IST
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

const locked = d => ksOn(d.killSwitch);

/** What the protection badge means right now, in words a trader understands. */
function protectionPill(d, st) {
  if (locked(d)) return pill('Kill switch on', 'red', { dot: true });
  if (st.protecting) return pill('Active', '', { dot: true, pulse: true });
  return pill(st.pill || 'Paused', st.pill === 'Market closed' ? 'grey' : 'amber', { dot: true });
}


function killRuleRows(d) {
  const k = d.killRules, r = d.rules;
  const rows = [];
  if (k.streakLimit) rows.push(html`<div><div class="top"><span>Losing streak</span><span class="num ${k.streak >= k.streakLimit - 1 && k.streak > 0 ? 'warn' : ''}">${k.streak} / ${k.streakLimit} in a row</span></div>${meter(k.streak / k.streakLimit, 'grey')}</div>`);
  if (r.giveback?.on) {
    rows.push(html`<div class="top"><span>Give-back ${r.giveback.value}% of ${inr(k.bookedPeak)} peak</span><span class="num">${k.givebackArmed
      ? html`stop at ${inr(k.givebackLevel)}`
      : html`<span class="dim">${k.givebackArmAt != null ? `arms at ${inr(k.givebackArmAt)} booked` : 'waiting for capital'}</span>`}</span></div>`);
  }
  return rows;
}

// Balances are hidden by default (eye button shows them), e.g. for screen sharing. Remembered on this browser.
const HIDE_KEY = 'tl-funds-visibility';
const shown = () => { try { return JSON.parse(localStorage.getItem(HIDE_KEY) || '{}'); } catch { return {}; } };
const isHidden = key => shown()[key] !== true;
function toggleHidden(key) {
  const h = shown();
  h[key] = isHidden(key);
  try { localStorage.setItem(HIDE_KEY, JSON.stringify(h)); } catch { /* storage blocked: toggles for this view only */ }
  return h;
}

/** Today's P&L after estimated charges (brokerage, STT, exchange, SEBI, stamp, GST); gross before the first figures arrive. */
const net = d => (Number.isFinite(d?.netPnl) ? d.netPnl : d?.pnl ?? 0);
const pnlFoot = d => `Gross ${inr(d.pnl, { sign: true })} · Charges −${inr(Math.abs(d.charges || 0))} · Open ${inr(d.unrealized, { sign: true })}`;

const fundsMissing = d => (d.broker.status === 'connected'
  ? `Appears after the first sync with ${d.broker.label}`
  : d.broker.status === 'expired' ? `Reconnect ${d.broker.label} to see it`
  : `${d.broker.label} is not responding`);

/** The daily stop-loss covers the whole account (Manual + Algo trades), set on Risk rules. */
function slSets(sl) {
  const x = sl.manual, amount = !x.on ? 'Off' : x.amount ? inr(x.amount) : `${x.value}%`;
  return html`<div class="sl-sets"><a href="/rules" data-nav="rules"><div class="sl-set now"><span>Manual + Algo <span class="pill sm">Whole account</span></span><b class="num">${amount}</b></div></a></div>`;
}

/** Legend: the Algo and Manual parts of the day's P&L with their latest values (once Algo Trading has traded today). */
function splitLegend(points) {
  const s = pnlSplit((points || []).filter(p => p.minute >= OPEN - 15));
  if (!s) return '';
  const cls = s.both ? '' : ' dot';   // no lines drawn yet: just the values
  return html`<span><i class="l-sky${cls}"></i>Algo ${inr(s.algoNow, { sign: true })}</span><span><i class="l-violet${cls}"></i>Manual ${inr(s.manualNow, { sign: true })}</span>`;
}

function fundCard(d, key, label, value, foot, refresh = false, accent = 'acc-mint') {
  const hide = isHidden(key);
  return html`
    <div class="panel kpi fund-kpi ${accent}">
      <div class="lbl">${label}<span class="kpi-tools">
        ${refresh ? html`<button class="icon-btn sm" id="refresh-broker" title="Refresh from ${d.broker.label}" aria-label="Refresh from ${d.broker.label}">${icon('refresh')}</button>` : ''}
        <button class="icon-btn sm" data-hide="${key}" title="${hide ? 'Show' : 'Hide'} amount" aria-label="${hide ? 'Show' : 'Hide'} ${label}" aria-pressed="${hide}">${icon(hide ? 'eyeOff' : 'eye')}</button>
      </span></div>
      <div class="val">${hide ? html`<span class="masked">₹ ••••••</span>` : value == null ? '–' : inr(value, { dp: 2 })}</div>
      <div class="foot">${foot}</div>
    </div>`;
}

const RULE_NAMES = { maxLoss: 'daily stop-loss', maxTrades: 'trades-per-day limit', profitLock: 'profit target', cutoff: 'cutoff time', lossStreak: 'losing-streak rule', giveback: 'profit give-back rule' };

/** What is stopping trading today: the broker's kill switch (whole account locked), or a rule. */
function lockBanner(d) {
  const locked = ksOn(d.killSwitch);
  const rule = d.pauseReason?.startsWith('rule:') ? RULE_NAMES[d.pauseReason.slice(5)] : null;
  if (d.paused && rule && !locked) {
    return html`<div class="banner amber mb">${icon('power')}<div class="grow"><b>Trading stopped for today.</b> Your ${rule} was hit. Rules reset on the next trading day.</div></div>`;
  }
  return '';
}

export default {
  title: 'Overview',
  sub: s => (s.dash ? `${longDay(s.dash.day)} · ${s.dash.marketOpen ? 'Market open' : 'Market closed'}` : ''),
  layout: 'app',
  auth: true,
  live: ['dash'],

  load: () => get('/dashboard/intraday'),

  onStore(ctx, patch) {
    const d = patch.dash || ('pnl' in patch ? ctx.state.dash : null);
    if (!d || d.day !== ctx.data.day) return;
    const minute = istNow().minutes;
    const pts = ctx.data.points;
    if (pts.at(-1)?.minute === minute) Object.assign(pts.at(-1), { pnl: d.pnl, algo: d.algoPnl ?? null, charges: d.charges ?? null });
    else pts.push({ minute, pnl: d.pnl, algo: d.algoPnl ?? null, charges: d.charges ?? null });
    if (!('pnl' in patch) || patch.dash) return;
    // Live P&L from market ticks: just the numbers and the curve, no repaint of the page.
    const set = (sel, text, cls) => { const n = ctx.el.querySelector(sel); if (n) { if (n.textContent !== text) n.textContent = text; if (cls != null) n.className = cls; } };
    set('#kpi-pnl', inr(net(d), { sign: true }), `val ${tone(net(d))}`);
    set('#kpi-pnl-foot', pnlFoot(d));
    for (const p of d.positions || []) {
      set(`[data-pos-pnl="${p.securityId}"]`, inr(p.unrealized, { sign: true }), `r num ${tone(p.unrealized)}`);
      set(`[data-pos-ltp="${p.securityId}"]`, price(p.ltp));
    }
    // The intraday chart redraws at most twice a second.
    if (Date.now() - (ctx.ui.livePnlDrawn || 0) > 500) { ctx.ui.livePnlDrawn = Date.now(); this.draw?.(ctx); }
  },

  view(ctx) {
    const d = ctx.state.dash;
    if (!d) return html`<div class="loading">Waiting for the first sync…</div>`;
    if (!d.broker) return html`<div class="panel">${empty('link', 'Connect a broker to start monitoring', 'TradeLock checks your rules against live positions from your broker. Nothing is monitored until a broker is connected.', ['brokers', 'Connect broker'])}</div>`;

    const st = statusOf(ctx.state);
    const r = d.rules;
    const capOn = r.maxTrades.on, left = r.maxTrades.value - d.entries;
    const open = d.positions;
    return html`
      <div class="kpis ov-kpis">
        <div class="panel kpi ov-kpi-pnl ${net(d) < 0 ? 'acc-red' : 'acc-mint'}">
          <div class="lbl">Today's P&amp;L <small class="muted">after charges</small> ${st.protecting ? pill('Live', '', { sm: true }) : st.pill === 'Market closed' ? pill('Closed', 'grey', { sm: true }) : pill(st.pill || 'Delayed', 'amber', { sm: true })}</div>
          <div class="val ${tone(net(d))}" id="kpi-pnl" title="After estimated charges">${inr(net(d), { sign: true })}</div>
          <div class="foot" id="kpi-pnl-foot">${pnlFoot(d)}</div>
          <svg class="spark" id="spark" aria-hidden="true"></svg>
        </div>
        <div class="panel kpi ov-kpi-loss acc-amber">
          <div class="lbl">Daily loss limit</div>
          <div class="val">${!r.maxLoss.on ? 'Off' : d.limits.maxLoss ? inr(d.limits.maxLoss) : `${r.maxLoss.value}%`}</div>
          <div class="foot">${!r.maxLoss.on ? 'No stop-loss today' : d.limits.maxLoss ? "Today's stop-loss" : 'Waiting for starting capital'}</div>
          ${d.stopLosses ? slSets(d.stopLosses) : ''}
        </div>
        ${fundCard(d, 'available', 'Available margin', d.funds?.available, d.funds ? `Free to trade · ${d.broker.label} ${d.broker.lastSyncAt ? `updated ${ago(d.broker.lastSyncAt)}` : ''}` : fundsMissing(d), true)}
        ${fundCard(d, 'opening', 'Opening balance', d.funds?.opening, d.funds ? 'Start of day' : fundsMissing(d), false, 'acc-ice')}
      </div>

      ${d.broker.permissions?.ordersAllowed === false ? html`<div class="banner red mb">${icon('alert')}<div class="grow"><b>${d.broker.label} will reject exits from TradeLock.</b> Its static IP setting doesn't include this server (${d.broker.permissions.serverIp}), so automatic square-off and emergency exits won't work.</div><a class="btn btn-sm" href="/brokers">How to fix</a></div>` : ''}
      ${lockBanner(d)}
      <div class="ks-slot ks-top mb" id="ks-overview-top"></div>

      <div class="split fill">
        <div class="panel pad chart-panel">
          <div class="panel-head">
            <h3 class="panel-title">Intraday P&amp;L</h3>
            <div class="legend"><span><i class="l-mint"></i>Day P&amp;L after charges</span>${splitLegend(ctx.data.points)}${d.limits?.maxLoss ? html`<span><i class="l-red dashed"></i>${otherSl(d) ? (d.stopLosses.mode === 'algo' ? 'Algo SL' : 'Manual SL') : 'Stop-loss'} −${inr(d.limits.maxLoss)}</span>${otherSl(d) ? html`<span><i class="l-amber dashed"></i>${otherSl(d).key === 'algo' ? 'Algo SL' : 'Manual SL'} −${inr(otherSl(d).amount)}</span>` : ''}` : !r.maxLoss.on ? html`<span><i class="l-red dashed"></i>No stop-loss</span>` : ''}${d.limits?.profitLock ? html`<span><i class="l-mint dashed"></i>${otherTarget(d) ? (d.profitTargets.mode === 'algo' ? 'Algo target' : 'Manual target') : 'Target'} ${inr(d.limits.profitLock)}</span>` : !r.profitLock.on && !otherTarget(d) ? html`<span><i class="l-mint dashed"></i>No profit limit</span>` : ''}${otherTarget(d) ? html`<span><i class="l-mint dashed faint"></i>${otherTarget(d).key === 'algo' ? 'Algo target' : 'Manual target'} ${inr(otherTarget(d).amount)}${d.limits?.profitLock ? '' : ' (not in force)'}</span>` : ''}${r.cutoff.on ? html`<span><i class="l-amber"></i>Cutoff ${fmt12(r.cutoff.value)}</span>` : ''}<span><i class="l-red dot"></i>Day low</span></div>
          </div>
          <svg class="chart" id="intraday" role="img" aria-label="Intraday P&L, now ${inr(d.pnl, { sign: true })}, low ${inr(d.worst)}"></svg>
        </div>
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">Risk protection</h3>${protectionPill(d, st)}</div>
          <div class="prot">
            <div class="prot-ring">
              <div class="ring" id="trade-ring"><svg viewBox="0 0 100 100"></svg><div class="ring-label"><div><b>${capOn ? `${d.entries}/${r.maxTrades.value}` : d.entries}</b><small>Entries</small></div></div></div>
              <div><b>Trade cap</b><div class="muted small">${!capOn ? 'Off. No limit on entries today.' : left > 0 ? `${left} more ${left === 1 ? 'entry' : 'entries'} allowed today.` : 'Cap reached. No new entries today.'}</div></div>
            </div>
            <div><div class="top"><span>Daily loss used (worst point)</span><span class="num">${inr(Math.max(0, -d.worst))} / ${d.limits.maxLoss ? inr(d.limits.maxLoss) : r.maxLoss.on ? '–' : 'no limit'}</span></div>${meter(d.usage.loss, d.usage.loss >= 0.8 ? 'red' : '')}</div>
            <div><div class="top"><span>Profit lock progress</span><span class="num">${inr(Math.max(0, d.pnl))} / ${d.limits.profitLock ? inr(d.limits.profitLock) : r.profitLock.on ? '–' : 'no limit'}</span></div>${meter(d.usage.profit)}</div>
            <div><div class="top"><span>Time to cutoff</span><span class="num">${d.marketOpen ? duration(d.usage.cutoffLeftMin) : 'Market closed'}</span></div>${meter(d.marketOpen ? d.usage.session : 0, 'amber')}</div>
            ${killRuleRows(d)}
            <div class="ks-slot ks-side" id="ks-overview"></div>
          </div>
        </div>
      </div>


      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">Open positions and orders</h3><a class="btn btn-sm" href="/positions">Positions ${icon('arrow')}</a></div>
        ${open.length || d.orders.length ? html`
          <div class="tbl-wrap"><table class="tbl cards">
            <thead><tr><th>Instrument</th><th>Type</th><th class="r">Qty</th><th class="r">Avg / limit</th><th class="r">LTP</th><th class="r">Open P&amp;L</th><th></th></tr></thead>
            <tbody>
              ${open.map(p => html`<tr>
                <td class="inst span"><b>${p.symbol}</b><span>Position</span></td><td data-label="Type"><span class="side-tag ${p.qty > 0 ? 'buy' : 'sell'}">${p.qty > 0 ? 'LONG' : 'SHORT'}</span></td>
                <td class="r num" data-label="Qty">${Math.abs(p.qty)}</td><td class="r num" data-label="Avg">${price(p.avg)}</td><td class="r num" data-label="LTP" data-pos-ltp="${p.securityId}">${price(p.ltp)}</td>
                <td class="r num ${tone(p.unrealized)}" data-label="Open P&L" data-pos-pnl="${p.securityId}">${inr(p.unrealized, { sign: true })}</td>
                <td class="r span"><button class="btn btn-sm btn-close" data-exit="${p.symbol}">${icon('x')}Close</button></td></tr>`)}
              ${d.orders.map(o => html`<tr>
                <td class="inst span"><b>${o.symbol}</b><span>${o.type.toLowerCase()} order</span></td><td data-label="Side"><span class="side-tag ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side}</span></td>
                <td class="r num" data-label="Qty">${o.qty}</td><td class="r num" data-label="Limit">${price(o.price)}</td><td class="r num hide-card">–</td><td class="r num muted" data-label="Status">Pending</td>
                <td class="r span"><button class="btn btn-sm" data-cancel="${o.id}">Cancel</button></td></tr>`)}
            </tbody>
          </table></div>` : html`<p class="muted" style="margin:0">No open positions or pending orders.</p>`}
      </div>

      <div class="banner info mt">${icon('info')}<div><b>How protection works.</b> TradeLock checks your rules against your ${d.broker.label} positions on every sync. ${d.broker.capabilities?.accountLock === 'killswitch'
        ? `When a limit is hit, it closes your positions and turns on the ${d.broker.label} kill switch, so no new orders can be placed in your ${d.broker.label} account (also from its app) until you switch it off or the next trading day.`
        : `When a limit is hit, it closes your positions. An account-wide lock is not available for ${d.broker.label}.`}</div></div>`;
  },

  draw(ctx) {
    // One control at the top on phones / the app, one in Risk protection on desktop (CSS shows one of them).
    for (const id of ['ks-overview', 'ks-overview-top']) {
      const slot = document.getElementById(id);
      if (slot && !slot.dataset.ready) { slot.dataset.ready = '1'; mountKillSwitch(slot, ctx.signal); }
    }
    const d = ctx.state.dash;
    if (!d?.broker) return;
    const ringEl = document.getElementById('trade-ring');
    if (ringEl) ring(ringEl, d.usage.trades);
    const pts = ctx.data.points.filter(p => p.minute >= OPEN - 15).map(p => [p.minute, p.pnl - (Number(p.charges) || 0)]);   // after charges at that minute
    if (!pts.length) pts.push([istNow().minutes, net(d)]);
    const spark = document.getElementById('spark');
    const ys = pts.map(p => p[1]);
    if (spark) lineChart(spark, pts, { bare: true, yDomain: [Math.min(0, ...ys) - 200, Math.max(0, ...ys) + 200] });

    const svg = document.getElementById('intraday');
    if (!svg) return;
    // Today's levels: the stop-loss (daily loss limit) and the profit-lock target, both in rupees.
    const sl = d.limits?.maxLoss ? -d.limits.maxLoss : null;
    const target = d.limits?.profitLock || null;
    const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // The other rule set's stop-loss (Manual / Algo), when it differs: a second, fainter line labelled at the right end.
    const other = otherSl(d), names = { manual: 'Manual SL', algo: 'Algo SL' };
    const otherT = otherTarget(d), tNames = { manual: 'Manual target', algo: 'Algo target' };
    const hlines = [
      sl != null && { y: sl, color: css('--red'), label: other ? `${names[d.stopLosses.mode]} ${inr(sl)} (active)` : `Stop-loss ${inr(sl)}` },
      other && { y: -other.amount, color: css('--amber'), label: `${names[other.key]} ${inr(-other.amount)}`, dash: '3 5', opacity: 0.75, end: true },
      target && { y: target, color: css('--mint'), label: otherT ? `${tNames[d.profitTargets.mode]} ${inr(target, { sign: true })} (active)` : `Target ${inr(target, { sign: true })}` },
      otherT && { y: otherT.amount, color: css('--mint'), label: `${tNames[otherT.key]} ${inr(otherT.amount, { sign: true })}${target ? '' : ' (not in force)'}`, dash: '3 5', opacity: 0.45, end: true },
    ].filter(Boolean);
    // A level that is switched off is stated on the chart instead of drawn.
    const notes = [
      !d.rules.profitLock.on && !otherT && { text: 'No profit limit ↑', color: css('--mint'), at: 'top' },
      !d.rules.maxLoss.on && { text: 'No stop-loss ↓', color: css('--red'), at: 'bottom' },
    ].filter(Boolean);
    // Zero always sits in the middle: the scale runs the same distance up and down.
    // Algo / Manual P&L as two more lines, once both have moved today (otherwise the total line already is the one).
    const split = pnlSplit(ctx.data.points.filter(p => p.minute >= OPEN - 15));
    const series = split?.both ? [{ pts: split.manual, color: css('--violet') }, { pts: split.algo, color: css('--sky') }] : [];
    const reach = Math.max(1, ...[...ys, ...series.flatMap(s => s.pts.map(p => p[1])), d.worst, sl ?? 0, other ? other.amount : 0, target ?? 0, otherT ? otherT.amount : 0].map(Math.abs));
    const sc = niceScale(-reach, reach, 6);
    const x0 = Math.min(OPEN, pts[0][0]), x1 = Math.max(CLOSE, pts.at(-1)[0]);
    const low = pts.reduce((a, p) => (p[1] < a[1] ? p : a), pts[0]);
    const xTicks = [];
    const step = svg.clientWidth < 520 ? 150 : 75;   // fewer time labels on phones so they don't overlap
    for (let m = OPEN; m <= x1; m += step) xTicks.push([m, hhmm(m)]);
    lineChart(svg, pts, {
      xDomain: [x0, x1], yDomain: [sc.lo, sc.hi], yTicks: sc.ticks, fmtY: axisInr, xTicks, hlines, notes, series,
      vlines: d.rules.cutoff.on ? [{ x: toMin(d.rules.cutoff.value), color: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim(), label: 'Cutoff' }] : [],
      low: low[1] < 0 ? [low[0], low[1], inr(low[1])] : null,
      endLabel: inr(net(d), { sign: true }),
    });
  },

  mount(ctx) {
    const { el, signal } = ctx;
    on(el, 'click', '[data-exit]', (_, b) => busy(b, async () => {
      try { await post('/positions/exit', { symbol: b.dataset.exit }); toast(`Exit order sent for ${b.dataset.exit}. Waiting for broker confirmation.`); }
      catch (e) { toastError(e); }
    }), signal);
    on(el, 'click', '#refresh-broker', (_, b) => busy(b, async () => {
      try { await post(`/brokers/${ctx.state.dash.broker.id}/sync`); toast('Refreshed from your broker.'); }
      catch (e) { toastError(e); }
    }), signal);
    on(el, 'click', '[data-hide]', (_, b) => { toggleHidden(b.dataset.hide); ctx.paint(); }, signal);
    on(el, 'click', '[data-cancel]', (_, b) => busy(b, async () => {
      try { await del(`/orders/${encodeURIComponent(b.dataset.cancel)}`); toast('Order cancelled.'); }
      catch (e) { toastError(e); }
    }), signal);
  },
};
