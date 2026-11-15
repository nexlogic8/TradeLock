// Power Scalper drawing tools (web/js/pages/scalper-chart-draw.js): the maths behind placing and editing drawings.
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { logicalOfTime, timeOfLogical, distToLine, positionStats, FIB_LEVELS, DRAW_TOOLS } = await import('../../web/js/pages/scalper-chart-draw.js');

test('a point keeps its candle: time ↔ bar index, inside the data, across a session gap and beyond both ends', () => {
  // 1-minute bars 09:15–09:17, then the next day 09:15 (an overnight gap).
  const times = [1000, 1060, 1120, 90000], step = 60;
  assert.equal(logicalOfTime(times, step, 1060), 1);
  assert.equal(logicalOfTime(times, step, 1090), 1.5, 'half way between two bars');
  assert.ok(Math.abs(logicalOfTime(times, step, 45560) - 2.5) < 1e-9, 'half way across the overnight gap');
  assert.equal(logicalOfTime(times, step, 90000 + 600), 13, 'ten bars into the future');
  assert.equal(logicalOfTime(times, step, 1000 - 120), -2, 'two bars before the first');
  for (const l of [-2, 0, 1.5, 2.5, 3, 13]) assert.ok(Math.abs(logicalOfTime(times, step, timeOfLogical(times, step, l)) - l) < 1e-9, `round trip at ${l}`);
  assert.equal(logicalOfTime([], step, 1000), null);
});

test('hit testing: distance to a segment, a ray and a full line', () => {
  assert.equal(distToLine(5, 3, 0, 0, 10, 0), 3, 'above the middle of the segment');
  assert.equal(distToLine(14, 0, 0, 0, 10, 0), 4, 'past the end of a segment: distance to the end point');
  assert.equal(distToLine(14, 0, 0, 0, 10, 0, 'ray'), 0, 'a ray carries on past its second point');
  assert.equal(distToLine(-6, 0, 0, 0, 10, 0, 'ray'), 6, 'but not behind its start');
  assert.equal(distToLine(-6, 0, 0, 0, 10, 0, 'line'), 0, 'an extended line goes both ways');
});

test('long and short positions: reward, risk, R:R and % moves from the entry', () => {
  const long = positionStats({ type:'long', pts:[{ t:0, p:100 }], stop:95, target:110 });
  assert.deepEqual([long.reward, long.risk, long.rr, long.targetPct, long.stopPct], [10, 5, 2, 10, -5]);
  const short = positionStats({ type:'short', pts:[{ t:0, p:200 }], stop:210, target:170 });
  assert.deepEqual([short.reward, short.risk, short.rr, short.targetPct, short.stopPct], [30, 10, 3, -15, 5]);
  assert.equal(positionStats({ type:'long', pts:[{ t:0, p:100 }], stop:101, target:110 }).rr, 0, 'a stop on the wrong side has no R:R');
});

test('toolbar: every tool is listed, Fib levels in order', () => {
  assert.deepEqual(DRAW_TOOLS.map(([k]) => k), ['cursor', 'trend', 'ray', 'ext', 'arrow', 'hline', 'hray', 'vline', 'rect', 'fib', 'long', 'short', 'measure', 'text']);
  assert.deepEqual(FIB_LEVELS, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
});

test('after drawing, the chart scrolls and zooms again (the settings are copied, not referenced)', async () => {
  const { pauseScroll, resumeScroll } = await import('../../web/js/pages/scalper-chart-draw.js');
  // Like lightweight-charts: options() returns the chart's live objects, and applyOptions writes into them.
  const live = { handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { mouseWheel: true, pinch: true } };
  const chart = {
    options: () => live,
    applyOptions(o) {
      for (const k of ['handleScroll', 'handleScale']) if (k in o) {
        if (typeof o[k] === 'boolean') for (const f of Object.keys(live[k])) live[k][f] = o[k];
        else Object.assign(live[k], o[k]);
      }
    },
  };
  const saved = pauseScroll(chart);
  assert.equal(live.handleScroll.pressedMouseMove, false, 'paused while drawing');
  resumeScroll(chart, saved);
  assert.deepEqual(live, { handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { mouseWheel: true, pinch: true } }, 'back exactly as it was');
});

test('chart "+" menu: a horizontal line at a price is an ordinary drawing (selectable, saved)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../web/js/pages/scalper-chart-draw.js', import.meta.url), 'utf8');
  assert.match(src, /addHorizontal\(price\) \{/);
  const lv = (await import('node:fs')).readFileSync(new URL('../../web/js/pages/scalper-chart-levels.js', import.meta.url), 'utf8');
  assert.match(lv, /data-lvl="hline"/, 'the menu offers it');
  assert.match(lv, /ALERT \$\{a\.dir === 'below' \? '≤' : '≥'\}/, 'alerts: a labelled purple line (bell drawn on the canvas)');
});
