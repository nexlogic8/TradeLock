import { html } from '../core/dom.js';
import { get } from '../core/api.js';
import { inr, tone, pct, shortDay, longDay, axisInr } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { empty } from '../ui/parts.js';
import { lineChart, barChart, niceScale } from '../ui/charts.js';

export default {
  title: 'Performance analytics',
  sub: 'Understand trading behaviour, not just returns',
  layout: 'app',
  auth: true,

  load: () => get('/analytics?sessions=20'),

  view(ctx) {
    const a = ctx.data;
    if (!a.sessions) return html`<div class="panel">${empty('chart', 'No sessions yet', 'Analytics fill in after your first monitored trading day.')}</div>`;
    const insight = a.avgLossDay == null
      ? 'No losing days in this period.'
      : !a.maxLoss
      ? `Your losing days average ${inr(a.avgLossDay)}.`
      : `Your losing days average ${inr(a.avgLossDay)}, which is ${Math.round((-a.avgLossDay / a.maxLoss) * 100)}% of your ${inr(a.maxLoss)} daily limit.`;
    return html`
      <div class="kpis three">
        <div class="panel kpi"><div class="lbl">Win rate</div><div class="val">${pct(a.winRate, 1)}</div><div class="foot">${a.wins} of ${a.trades} closed trades · last ${a.sessions} sessions</div></div>
        <div class="panel kpi"><div class="lbl">Rule adherence</div><div class="val">${pct(a.adherence)}</div><div class="foot">Sessions that ended without a hard limit crossed</div></div>
        <div class="panel kpi"><div class="lbl">Net P&amp;L</div><div class="val ${tone(a.netPnl)}">${inr(a.netPnl, { sign: true })}</div><div class="foot">${shortDay(a.from)} – ${shortDay(a.to)}</div></div>
      </div>
      <div class="split">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">Equity curve</h3><div class="legend"><span><i class="l-mint"></i>Cumulative P&amp;L</span><span><i class="l-red"></i>Loss day</span></div></div>
          <svg class="chart" id="equity" style="height:220px" role="img" aria-label="Cumulative P&L over ${a.sessions} sessions, ending at ${inr(a.netPnl)}"></svg>
          <svg class="chart" id="daily" style="height:120px;margin-top:8px" role="img" aria-label="Daily P&L for each session"></svg>
        </div>
        <div class="panel pad">
          <h3 class="panel-title">Discipline insights</h3>
          <div class="kv mt-s">
            <div><span class="muted">Risk limits triggered</span><b class="num pos">${a.limitsTriggered}</b></div>
            <div><span class="muted">Days an over-limit order was blocked</span><b class="num pos">${a.overtradingDaysAvoided}</b></div>
            <div><span class="muted">Connection uptime</span><b class="num ${a.uptime < 0.98 ? 'warn' : 'pos'}">${pct(a.uptime, 1)}</b></div>
            <div><span class="muted">Worst day${a.worstDay ? ` · ${shortDay(a.worstDay.day)}` : ''}</span><b class="num ${a.worstDay ? 'neg' : ''}">${a.worstDay ? inr(a.worstDay.pnl) : '–'}</b></div>
          </div>
          <div class="banner info mt">${icon('info')}<div>${insight}</div></div>
        </div>
      </div>`;
  },

  draw(ctx) {
    const a = ctx.data;
    const eq = document.getElementById('equity');
    if (!eq || !a.series.length) return;
    const pts = [[-1, 0], ...a.series.map((s, i) => [i, s.cumulative])];
    const sc = niceScale(Math.min(0, ...pts.map(p => p[1])), Math.max(...pts.map(p => p[1])), 4);
    const n = a.series.length;
    const tickIdx = [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4), n - 1].filter((v, i, arr) => arr.indexOf(v) === i && v < n);
    const labels = a.series.map(s => shortDay(s.day));
    const css = getComputedStyle(document.documentElement), red = css.getPropertyValue('--red').trim(), mint = css.getPropertyValue('--mint').trim();
    lineChart(eq, pts, { xDomain: [-1, n - 1], yDomain: [sc.lo, sc.hi], yTicks: sc.ticks, fmtY: axisInr, xTicks: tickIdx.map(i => [i, labels[i]]), endLabel: axisInr(a.netPnl), smooth: true,
      // Hover: that session's date and P&L (its own colour) with the running total.
      hover: i => {
        if (!i) return { title: 'Start', value: inr(0), sub: 'Cumulative P&L' };
        const s = a.series[i - 1];
        return { title: longDay(s.day), value: `Day ${inr(s.pnl, { sign: true })}`, color: s.pnl < 0 ? red : mint, sub: `Cumulative ${inr(s.cumulative, { sign: true })}` };
      } });
    const vals = a.series.map(s => s.pnl);
    const bs = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), 2);
    barChart(document.getElementById('daily'), vals, { yDomain: [bs.lo, bs.hi], fmtY: axisInr, labels, xTicks: tickIdx, fmtTip: v => inr(v, { sign: true }) });
  },
};
