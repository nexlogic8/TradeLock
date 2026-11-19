// P&L calendar: a month of trading days at a glance, the month's running P&L, and any day's intraday curve.
import { html, on } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { inr, tone, axisInr, longDay, shortDay, ago } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { pill } from '../ui/parts.js';
import { toast } from '../ui/toast.js';
import { lineChart, barChart, niceScale } from '../ui/charts.js';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OPEN = 555, CLOSE = 930;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const todayIST = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
const monthLabel = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function shiftMonth(month, by) {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const YEARS_BACK = 5;

/** Month and year dropdowns; months after the current one are not selectable. */
function monthPicker(month) {
  const [y, m] = month.split('-').map(Number);
  const [cy, cm] = todayIST().slice(0, 7).split('-').map(Number);
  const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => cy - YEARS_BACK + i);
  return html`
    <select class="input cal-sel" id="cal-month" aria-label="Month">${MONTHS.map((name, i) => html`
      <option value="${i + 1}" ${i + 1 === m ? 'selected' : ''} ${y === cy && i + 1 > cm ? 'disabled' : ''}>${name}</option>`)}</select>
    <select class="input cal-sel cal-year" id="cal-year" aria-label="Year">${years.map(yr => html`
      <option value="${yr}" ${yr === y ? 'selected' : ''}>${yr}</option>`)}</select>`;
}

const daysIn = month => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();

function grid(ctx) {
  const { month, days } = ctx.data;
  const byDay = new Map(days.map(d => [d.day, d]));
  const maxAbs = Math.max(1, ...days.map(d => Math.abs(d.pnl)));
  const first = new Date(`${month}-01T12:00:00Z`).getUTCDay();   // 0 = Sunday
  const lead = (first + 6) % 7;                                    // weeks start on Monday
  const today = todayIST();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(html`<div class="cal-cell blank"></div>`);
  for (let n = 1; n <= daysIn(month); n++) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    const d = byDay.get(day);
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    const future = day > today;
    const shade = d && d.pnl !== 0 ? Math.round(10 + 32 * (Math.abs(d.pnl) / maxAbs)) : 0;
    const style = shade ? `background: color-mix(in srgb, var(${d.pnl > 0 ? '--mint' : '--red'}) ${shade}%, var(--well))` : '';
    cells.push(html`
      <button type="button" class="cal-cell ${weekend ? 'weekend' : ''} ${future ? 'future' : ''} ${day === today ? 'today' : ''} ${ctx.ui.sel === day ? 'sel' : ''} ${d ? 'has' : ''}"
        data-day="${day}" ${future ? 'disabled' : ''} style="${style}" aria-label="${longDay(day)}${d ? `: ${inr(d.pnl, { sign: true })}` : ''}">
        <span class="cal-n">${n}${d?.locked ? html`<span title="Kill switch locked the account">${icon('lock')}</span>` : d?.breaches ? html`<span title="A limit was hit">${icon('alert')}</span>` : ''}</span>
        ${d ? html`
          <b class="num ${tone(d.pnl)} cal-full">${inr(d.pnl, { sign: true })}</b>
          <b class="num ${tone(d.pnl)} cal-short">${axisInr(d.pnl)}</b>
          <span class="cal-t">${d.entries ? `${d.entries} trade${d.entries === 1 ? '' : 's'}` : 'no trades'}</span>` : ''}
      </button>`);
  }
  return html`
    <div class="cal-head">${WEEK.map(w => html`<span>${w}</span>`)}</div>
    <div class="cal-grid">${cells}</div>`;
}

function dayPanel(ctx) {
  const sel = ctx.ui.sel;
  const d = ctx.data.days.find(x => x.day === sel);
  if (!sel) return html`<p class="muted" style="margin:0">Pick a day in the calendar to see how it went.</p>`;
  return html`
    <div class="panel-head"><h3 class="panel-title">${longDay(sel)}</h3>
      ${d ? pill(d.pnl >= 0 ? 'Green day' : 'Red day', d.pnl >= 0 ? '' : 'red', { sm: true }) : pill('No activity', 'grey', { sm: true })}</div>
    ${d ? html`
      <div class="cal-stats">
        <div><span class="muted small">Day P&amp;L</span><b class="num ${tone(d.pnl)}">${inr(d.pnl, { sign: true })}</b></div>
        ${d.source === 'broker' ? html`
        <div><span class="muted small">Gross P&amp;L</span><b class="num ${tone(d.gross)}">${inr(d.gross, { sign: true })}</b></div>
        <div><span class="muted small">Charges &amp; taxes</span><b class="num">${inr(-d.charges, { sign: true })}</b></div>` : html`
        <div><span class="muted small">Realized</span><b class="num">${inr(d.realized, { sign: true })}</b></div>`}
        <div><span class="muted small">Orders</span><b class="num">${d.entries}</b></div>
        <div><span class="muted small">Won / lost</span><b class="num">${d.wins} / ${d.losses}</b></div>
      </div>
      ${d.source === 'broker' ? html`<p class="tiny dim cal-src">${icon('check')}<span>Net of charges, from your broker's trade history.</span></p>` : ''}
      ${d.breaches || d.locked ? html`<p class="small muted cal-note">${icon('alert')}<span>${d.locked ? 'A limit was hit and the kill switch locked the account.' : `${d.breaches} limit${d.breaches === 1 ? ' was' : 's were'} hit.`}</span></p>` : ''}
      <svg class="chart cal-day-chart" id="day-chart" role="img" aria-label="Intraday P&L for ${shortDay(sel)}"></svg>
      ${sel === todayIST() ? html`<a class="small" href="/positions">Today's positions and fills →</a>` : ''}`
    : html`<p class="muted" style="margin:0">TradeLock has no record of trading on this day.</p>`}`;
}

/** "Synced from Dhan 5 min ago" + a button to pull the latest trade history now. */
function syncBox(ctx) {
  const s = ctx.data.brokerSync;
  const broker = ctx.state.dash?.broker?.label || ctx.state.user?.broker?.label || 'Dhan';
  if (ctx.state.dash?.broker?.broker !== 'dhan' && !s) return '';   // only brokers with a trade-history API
  const busy = ctx.ui.syncing || s?.status === 'running';
  const note = busy ? `Reading your ${broker} trade history…`
    : s?.status === 'error' ? `Last sync failed: ${s.error || 'try again'}`
    : s?.lastAt ? `Synced from ${broker} ${ago(s.lastAt)}` : `Not synced with ${broker} yet`;
  return html`
    <div class="cal-sync">
      <span class="tiny ${s?.status === 'error' && !busy ? 'neg' : 'dim'}">${note}</span>
      <button class="btn btn-sm" id="broker-sync" ${busy ? 'disabled' : ''}>${icon('refresh')}${busy ? 'Syncing…' : `Sync from ${broker}`}</button>
    </div>`;
}

async function loadDay(ctx, day) {
  ctx.ui.sel = day;
  ctx.ui.points = null;
  ctx.paint();
  if (!ctx.data.days.some(x => x.day === day)) return;
  try {
    const r = await get(`/dashboard/intraday?day=${day}`);
    if (ctx.ui.sel !== day) return;
    ctx.ui.points = r.points;
    drawDay(ctx);
  } catch { /* chart stays empty */ }
}

function drawDay(ctx) {
  const svg = document.getElementById('day-chart');
  const d = ctx.data.days.find(x => x.day === ctx.ui.sel);
  if (!svg || !d) return;
  const pts = (ctx.ui.points || []).filter(p => p.minute >= OPEN - 15).map(p => [p.minute, p.pnl - (Number(p.charges) || 0)]);   // after charges at that minute
  if (!pts.length) pts.push([OPEN, 0], [CLOSE, d.pnl]);
  const reach = Math.max(1, ...pts.map(p => Math.abs(p[1])));
  const sc = niceScale(-reach, reach, 4);
  const xTicks = [];
  const step = svg.clientWidth < 520 ? 125 : 75;
  for (let m = OPEN; m <= CLOSE; m += step) xTicks.push([m, hhmm(m)]);
  lineChart(svg, pts, { xDomain: [Math.min(OPEN, pts[0][0]), Math.max(CLOSE, pts.at(-1)[0])], yDomain: [sc.lo, sc.hi], yTicks: sc.ticks, fmtY: axisInr, xTicks, endLabel: inr(d.pnl, { sign: true }),
    smooth: true, hover: i => ({ title: `${shortDay(d.day)} · ${hhmm(Math.round(pts[i][0]))} IST`, value: inr(pts[i][1], { sign: true }), sub: 'P&L after charges' }) });
}

export default {
  title: 'P&L calendar',
  sub: 'Day-by-day results and how the month built up',
  layout: 'app',
  auth: true,

  async load(ctx) {
    ctx.ui.month ??= todayIST().slice(0, 7);
    const data = await get(`/analytics/calendar?month=${ctx.ui.month}`);
    // Default selection: today if it is in this month, else the month's last trading day.
    if (!ctx.ui.sel || ctx.ui.sel.slice(0, 7) !== data.month) {
      const today = todayIST();
      ctx.ui.sel = today.startsWith(data.month) ? today : data.days.at(-1)?.day ?? null;
      ctx.ui.points = null;
      ctx.ui.autoload = true;
    }
    return data;
  },

  view(ctx) {
    const { month, summary: s, days } = ctx.data;
    const isCurrent = month >= todayIST().slice(0, 7);
    return html`
      <div class="panel pad cal-bar">
        <div class="cal-left">
        <div class="cal-nav">
          <button class="icon-btn flip" data-month="-1" aria-label="Previous month">${icon('arrow')}</button>
          ${monthPicker(month)}
          <button class="icon-btn" data-month="1" aria-label="Next month" ${isCurrent ? 'disabled' : ''}>${icon('arrow')}</button>
        </div>
        ${ctx.data.paper ? html`<div class="banner info" style="margin:8px 0 0">${icon('info')}<div><b>Paper trading history.</b> Paper keeps its own P&amp;L, separate from your broker's. Switch to Real on AI Algo Trading to see your broker's days.</div></div>` : syncBox(ctx)}
        </div>
        <div class="cal-sum">
          <div><span class="muted small">Net P&amp;L</span><b class="num ${tone(s.net)}">${inr(s.net, { sign: true })}</b></div>
          <div><span class="muted small">Green / red days</span><b class="num"><span class="pos">${s.greenDays}</span> / <span class="neg">${s.redDays}</span></b></div>
          <div><span class="muted small">Best day</span><b class="num pos">${s.best ? `${inr(s.best.pnl, { sign: true })}` : '–'}</b>${s.best ? html`<span class="tiny dim">${shortDay(s.best.day)}</span>` : ''}</div>
          <div><span class="muted small">Worst day</span><b class="num neg">${s.worst ? inr(s.worst.pnl) : '–'}</b>${s.worst ? html`<span class="tiny dim">${shortDay(s.worst.day)}</span>` : ''}</div>
          <div><span class="muted small">Trades</span><b class="num">${s.trades}</b><span class="tiny dim">${s.limitDays ? `limits hit on ${s.limitDays} day${s.limitDays === 1 ? '' : 's'}` : 'no limits hit'}</span></div>
        </div>
      </div>

      <div class="split fill mt cal-split">
        <div class="panel pad">${grid(ctx)}</div>
        <div class="panel pad cal-day">${dayPanel(ctx)}</div>
      </div>

      <div class="panel pad mt">
        <div class="panel-head"><h3 class="panel-title">${icon('chart')} ${monthLabel(month)} P&amp;L</h3>
          <div class="legend"><span><i class="l-mint"></i>Running total</span><span><i class="l-mint dot"></i>Green day</span><span><i class="l-red dot"></i>Red day</span></div></div>
        ${days.length ? html`<svg class="chart" id="month-chart" role="img" aria-label="Running P&L for ${monthLabel(month)}: ${inr(s.net, { sign: true })}"></svg>
          <svg class="chart cal-bars" id="month-bars" aria-hidden="true"></svg>`
        : html`<p class="muted" style="margin:0">No trading recorded in ${monthLabel(month)}.</p>`}
      </div>`;
  },

  draw(ctx) {
    const { month, days, summary } = ctx.data;
    if (ctx.ui.autoload && ctx.ui.sel) { ctx.ui.autoload = false; loadDay(ctx, ctx.ui.sel); return; }
    drawDay(ctx);
    const svg = document.getElementById('month-chart');
    if (!svg || !days.length) return;
    // Running total across the month, one point per trading day (x = day of the month).
    let cum = 0;
    const pts = [[0, 0], ...days.map(d => [+d.day.slice(8), (cum += d.pnl)])];
    const reach = Math.max(1, ...pts.map(p => Math.abs(p[1])));
    const sc = niceScale(-reach, reach, 4);
    const last = daysIn(month);
    const xTicks = [1, 8, 15, 22, last].map(n => [n, `${n} ${monthLabel(month).slice(0, 3)}`]);
    const css = getComputedStyle(document.documentElement), red = css.getPropertyValue('--red').trim(), mint = css.getPropertyValue('--mint').trim();
    lineChart(svg, pts, { xDomain: [0, last], yDomain: [sc.lo, sc.hi], yTicks: sc.ticks, fmtY: axisInr, xTicks, endLabel: inr(summary.net, { sign: true }), smooth: true,
      // Hover: that day's date and P&L (its own colour), with the month's running total and its trades.
      hover: i => {
        if (!i) return { title: `Start of ${monthLabel(month)}`, value: inr(0), sub: 'Running total' };
        const day = days[i - 1];
        return { title: longDay(day.day), value: `Day ${inr(day.pnl, { sign: true })}`, color: day.pnl < 0 ? red : mint,
          sub: `Month ${inr(pts[i][1], { sign: true })} · ${day.entries || 0} trade${day.entries === 1 ? '' : 's'}` };
      } });
    // Daily results underneath, one bar per day of the month.
    const vals = Array.from({ length: last }, (_, i) => days.find(d => +d.day.slice(8) === i + 1)?.pnl ?? 0);
    const bs = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), 2);
    barChart(document.getElementById('month-bars'), vals, {
      yDomain: [bs.lo, bs.hi], fmtY: axisInr, labels: vals.map((_, i) => `${i + 1}`), xTicks: [0, 7, 14, 21, last - 1], fmtTip: v => inr(v, { sign: true }),
    });
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    on(el, 'click', '[data-day]', (_, b) => loadDay(ctx, b.dataset.day), signal);
    on(el, 'click', '#broker-sync', async () => {
      ui.syncing = true;
      ctx.paint();
      try {
        const r = await post('/analytics/broker-sync');
        toast(r.skipped === 'recent' ? 'Already up to date.' : r.skipped ? `Nothing to sync: ${r.skipped}.` : `Synced ${r.days} trading day${r.days === 1 ? '' : 's'} from your broker.`);
      } catch (e) { toast(e.message, 'error'); }
      ui.syncing = false;
      await ctx.reload();
    }, signal);
    // The first backfill runs in the background after connecting: refresh when it finishes.
    if (ctx.data.brokerSync?.status === 'running') {
      const poll = setInterval(async () => {
        if (signal.aborted) return clearInterval(poll);
        const s = (await get(`/analytics/calendar?month=${ui.month}`).catch(() => null))?.brokerSync;
        if (s && s.status !== 'running') { clearInterval(poll); await ctx.reload(); }
      }, 5000);
      signal.addEventListener('abort', () => clearInterval(poll));
    }
    on(el, 'change', '#cal-month, #cal-year', async () => {
      const y = Number(el.querySelector('#cal-year').value);
      const m = Number(el.querySelector('#cal-month').value);
      const now = todayIST().slice(0, 7);
      let next = `${y}-${String(m).padStart(2, '0')}`;
      if (next > now) next = now;   // e.g. a future month after switching to this year
      ui.month = next;
      ui.sel = null;
      await ctx.reload();
    }, signal);
    on(el, 'click', '[data-month]', async (_, b) => {
      ui.month = shiftMonth(ui.month, Number(b.dataset.month));
      ui.sel = null;
      await ctx.reload();
    }, signal);
  },
};
