// Picture of each built-in strategy (shown from the ⓘ on AI Algo Trading and Strategy): candles, levels,
// the signal, the entry arrow and the stop-loss, drawn as SVG. Colours come from CSS (.sart-*), so both
// themes work. CE examples; PE is the mirror image.
const W = 340, H = 200;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** One candle: x centre, open/close/high/low as y (smaller y = higher price). */
function candle(x, o, c, h, l, { w = 9, hl = '' } = {}) {
  const up = c < o, top = Math.min(o, c), body = Math.max(2, Math.abs(c - o));
  return `<g class="sart-c ${up ? 'up' : 'down'} ${hl}"><line x1="${x}" x2="${x}" y1="${h}" y2="${l}"/><rect x="${x - w / 2}" y="${top}" width="${w}" height="${body}" rx="1"/></g>`;
}
const text = (x, y, s, cls = '', anchor = 'start') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
const hline = (y, x1, x2, cls) => `<line class="${cls}" x1="${x1}" x2="${x2}" y1="${y}" y2="${y}"/>`;
/** Entry arrow pointing up, tip at (x, y), label to its right. */
const buy = (x, y, label) => `<g class="sart-buy"><path d="M${x} ${y} l-6 9 h4 v9 h4 v-9 h4 z"/>${text(x + 10, y + 14, label, 'sart-buy-t')}</g>`;
const svg = (body, title) => `<svg class="sart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${body}</svg>`;

function orb() {
  let b = `<rect class="sart-range" x="16" y="80" width="44" height="45" rx="3"/>${text(38, 138, '09:15–09:20', 'sart-dim', 'middle')}${text(38, 148, 'opening range', 'sart-dim', 'middle')}`;
  b += hline(80, 16, 330, 'sart-level') + text(330, 76, 'OR High', 'sart-lab', 'end');
  b += hline(125, 16, 330, 'sart-level') + text(330, 137, 'OR Low', 'sart-lab', 'end');
  b += candle(27, 98, 88, 82, 108) + candle(38, 88, 118, 84, 125) + candle(49, 118, 102, 96, 122);
  b += candle(74, 104, 96, 92, 110) + candle(88, 96, 108, 92, 114) + candle(102, 108, 92, 88, 112) + candle(116, 92, 98, 86, 102);
  b += candle(134, 100, 66, 60, 104, { hl: 'sart-hl' }) + `<circle class="sart-dot" cx="134" cy="54" r="3"/>` + text(128, 44, '① closes above OR High', 'sart-note', 'end');
  b += candle(152, 66, 44, 38, 70, { hl: 'sart-hl' }) + text(166, 22, '② next candle breaks its high,', 'sart-note') + text(166, 32, '   closes green (body ≥ 30%)', 'sart-note');
  b += buy(152, 74, '③ BUY ATM CE · next expiry');
  b += hline(104, 128, 330, 'sart-sl') + text(330, 116, 'SL: option’s breakout-candle low − 1 tick', 'sart-sl-t', 'end');
  b += text(16, 172, 'Exit: SL · 2 closes below EMA 9 · 15:00 square-off', 'sart-dim');
  b += text(16, 186, 'PE: mirror image below OR Low · several trades a day', 'sart-dim');
  return svg(b, 'ORB 5m picture');
}

function emaCross() {
  const ema21 = 'M16 62 C80 68 130 94 180 100 S280 84 330 68', ema9 = 'M16 80 C70 106 120 122 160 108 S250 56 330 40';
  let b = `<path class="sart-ema21" d="${ema21}"/><path class="sart-ema9" d="${ema9}"/>`;
  b += text(330, 34, 'EMA 9', 'sart-ema9-t', 'end') + text(330, 80, 'EMA 21', 'sart-ema21-t', 'end');
  b += candle(38, 84, 96, 80, 102) + candle(56, 96, 106, 92, 112) + candle(74, 106, 114, 102, 120) + candle(92, 114, 120, 110, 126) + candle(110, 120, 114, 110, 128) + candle(128, 114, 110, 106, 122);
  b += candle(148, 110, 98, 94, 116) + candle(168, 102, 88, 84, 106, { hl: 'sart-hl' }) + `<circle class="sart-dot" cx="168" cy="100" r="3"/>`;
  b += text(16, 20, '① EMA 9 crosses above EMA 21', 'sart-note') + text(16, 30, '   on a completed 5-minute close', 'sart-note');
  b += buy(168, 110, '② BUY ATM CE · next expiry');
  b += hline(106, 160, 330, 'sart-sl') + text(330, 146, 'SL: option’s crossover-candle low − 1 tick', 'sart-sl-t', 'end');
  b += text(16, 172, 'Exit: SL · 2 closes below EMA 9 · 15:00 square-off', 'sart-dim');
  b += text(16, 186, 'PE: EMA 9 crosses below EMA 21 · ORB wins a tie', 'sart-dim');
  return svg(b, 'EMA 9/21 crossover picture');
}

function hammer() {
  let b = hline(100, 16, 330, 'sart-ema45') + text(16, 94, 'EMA 45', 'sart-ema9-t');
  b += candle(54, 66, 60, 56, 72) + candle(70, 60, 70, 56, 74) + candle(86, 70, 64, 60, 76) + candle(102, 64, 72, 60, 78);
  b += text(78, 44, 'body clear of EMA 45/105', 'sart-dim', 'middle');
  b += candle(130, 78, 72, 70, 101, { hl: 'sart-hl' });
  b += candle(150, 72, 58, 54, 76, { hl: 'sart-hl' }) + text(166, 22, '② next 1-minute candle', 'sart-note') + text(166, 32, '   breaks the hammer’s high', 'sart-note');
  b += buy(150, 80, '③ signal CE');
  b += hline(101, 124, 330, 'sart-sl') + text(330, 114, 'stop: hammer low', 'sart-sl-t', 'end');
  b += text(130, 128, '① hammer: body above EMA 45,', 'sart-note', 'middle') + text(130, 138, 'lower wick ≥ body, touches it', 'sart-note', 'middle');
  b += text(16, 172, 'Chart signal and backtest only — not traded automatically', 'sart-dim');
  b += text(16, 186, 'PE: inverted hammer below EMA 45, next candle breaks its low', 'sart-dim');
  return svg(b, 'Hammer 1m picture');
}

function gap() {
  let b = hline(118, 16, 330, 'sart-level') + text(16, 112, 'yesterday’s close', 'sart-lab');
  b += candle(40, 112, 120, 108, 126) + candle(58, 120, 116, 112, 124);
  b += hline(84, 80, 330, 'sart-level') + text(330, 80, 'today’s open (gap up)', 'sart-lab', 'end');
  b += candle(100, 84, 62, 58, 88, { hl: 'sart-hl' }) + `<circle class="sart-dot" cx="100" cy="74" r="3"/>`;
  b += text(110, 30, '① 09:15:00.x first tick: CE premium gapped up', 'sart-note') + text(110, 40, '   → BUY ATM CE, full capital (nearest expiry)', 'sart-note');
  b += buy(100, 96, '② market buy at once (80% of funds)');
  b += candle(122, 62, 52, 48, 66) + candle(144, 52, 60, 46, 64, { hl: 'sart-hl' }) + text(152, 56, '③ 09:16:00 → market exit', 'sart-note');
  b += hline(140, 90, 330, 'sart-sl') + text(330, 152, 'SL: your daily stop-loss ÷ qty, at Dhan', 'sart-sl-t', 'end');
  b += text(16, 172, 'Once a day on the first tick · 80% of funds, no lot cap', 'sart-dim');
  b += text(16, 186, 'PE: PE premium gapped up · both / neither → no trade', 'sart-dim');
  return svg(b, 'Gap open 09:15 picture');
}

function emaScalp(fast, slow, live = false) {
  const ema5 = 'M16 70 C70 76 120 100 170 104 S270 80 330 66', ema3 = 'M16 86 C66 108 116 120 156 106 S240 50 330 36';
  let b = `<path class="sart-ema21" d="${ema5}"/><path class="sart-ema9" d="${ema3}"/>`;
  b += text(330, 30, `EMA ${fast}`, 'sart-ema9-t', 'end') + text(330, 78, `EMA ${slow}`, 'sart-ema21-t', 'end');
  b += candle(38, 88, 98, 84, 104) + candle(56, 98, 108, 94, 114) + candle(74, 108, 116, 104, 122) + candle(92, 116, 120, 112, 126) + candle(110, 120, 114, 110, 128) + candle(128, 114, 108, 104, 120);
  b += candle(148, 108, 96, 92, 112) + candle(166, 100, 88, 84, 104, { hl: 'sart-hl' }) + `<circle class="sart-dot" cx="166" cy="102" r="3"/>`;
  b += text(16, 20, `① EMA ${fast} crosses above EMA ${slow}`, 'sart-note') + text(16, 30, '   on a completed 1-minute close', 'sart-note');
  b += buy(166, 110, '② BUY ATM CE');
  b += text(16, 172, live ? `Exit: EMA ${fast} crosses back below EMA ${slow} → sell CE (no reversal)` : `Exit: EMA ${fast} crosses back below EMA ${slow} → sell CE, buy PE`, 'sart-dim');
  b += text(16, 186, live ? 'SL: option’s 1-minute crossover-candle low − 1 tick · cutoff' : 'No stop or target · 15:15 square-off', 'sart-dim');
  return svg(b, `EMA ${fast}/${slow} crossover picture`);
}

function emaTrend() {
  const ema15 = 'M16 70 C80 76 130 100 170 102 S280 86 330 72', ema9 = 'M16 86 C70 110 120 122 156 108 S230 46 330 30';
  let b = `<path class="sart-ema21" d="${ema15}"/><path class="sart-ema9" d="${ema9}"/>`;
  b += text(330, 24, 'EMA 9', 'sart-ema9-t', 'end') + text(330, 84, 'EMA 15', 'sart-ema21-t', 'end');
  b += candle(38, 88, 98, 84, 104) + candle(56, 98, 108, 94, 114) + candle(74, 108, 116, 104, 122) + candle(92, 116, 120, 112, 126) + candle(110, 120, 114, 110, 128) + candle(128, 114, 108, 104, 120);
  b += candle(148, 108, 96, 92, 112) + candle(168, 98, 76, 72, 102, { hl: 'sart-hl' }) + `<circle class="sart-dot" cx="168" cy="92" r="3"/>`;
  b += `<path class="sart-level" d="M150 104 h34"/><path class="sart-level" d="M150 104 l30 -17"/>` + text(188, 98, '≥ 30°', 'sart-note');
  b += text(16, 20, '① EMA 9 crosses above EMA 15 (5-minute)', 'sart-note') + text(16, 30, '② EMA 9 rising at 30°+ (vs ATR 14)', 'sart-note');
  b += buy(168, 110, '③ BUY ATM CE · next expiry');
  b += hline(102, 160, 330, 'sart-sl') + text(330, 146, 'SL: option’s signal-candle low − 1 tick', 'sart-sl-t', 'end');
  b += text(16, 172, 'Exit: first red 5-minute candle · SL · cutoff', 'sart-dim');
  b += text(16, 186, 'PE: mirror image · one trade per crossover', 'sart-dim');
  return svg(b, 'EMA 9/15 with 30° angle picture');
}

const ART = { orb, emaCross: () => emaScalp(5, 9, true), ema915: emaTrend, hammer, gap, ema35: () => emaScalp(3, 5), ema59: () => emaScalp(5, 9) };
export const strategyArt = key => (ART[key] ? ART[key]() : '');

/** ⓘ button with the picture as a hover / focus / tap popover. */
export const artInfo = (key, name) => `<span class="sart-anchor"><button class="algo-info" type="button" data-art-info aria-label="How ${esc(name)} works" title="How ${esc(name)} works">i</button><span class="sart-pop" role="tooltip"><b>${esc(name)}</b>${strategyArt(key)}</span></span>`;
