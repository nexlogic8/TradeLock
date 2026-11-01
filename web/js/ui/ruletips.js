// "How it works" pop-ups for the risk rules: a small diagram drawn with the trader's own numbers,
// plus one sentence. Shown on hover or keyboard focus (tap on phones).
import { html, raw } from '../core/dom.js';
import { inr } from '../core/format.js';
import { icon } from './icons.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const svg = body => raw(`<svg class="tip-svg" viewBox="0 0 260 120" aria-hidden="true">${body}</svg>`);
const label12 = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')}`; };

const DIAGRAMS = {
  maxLoss: ({ sl }) => svg(`
    <line class="d-zero" x1="14" y1="30" x2="246" y2="30"/><text class="d-t d-muted" x="16" y="24">₹0</text>
    <line class="d-red d-dash" x1="14" y1="94" x2="246" y2="94"/><text class="d-t d-red-t" x="16" y="110">Stop-loss ${esc(sl)}</text>
    <polyline class="d-line" points="14,30 44,24 74,40 104,34 134,58 164,70 196,94"/>
    <circle class="d-hit-red" cx="196" cy="94" r="5"/><text class="d-t d-red-t" x="204" y="86">exit</text>`),

  profitLock: ({ target }) => svg(`
    <line class="d-zero" x1="14" y1="96" x2="246" y2="96"/><text class="d-t d-muted" x="16" y="112">₹0</text>
    <line class="d-mint d-dash" x1="14" y1="26" x2="246" y2="26"/><text class="d-t d-mint-t" x="16" y="18">Target ${esc(target)}</text>
    <polyline class="d-line" points="14,96 44,88 74,92 104,66 134,72 164,46 198,26"/>
    <circle class="d-hit-mint" cx="198" cy="26" r="5"/><text class="d-t d-mint-t" x="206" y="44">stop</text>`),

  maxTrades: ({ n }) => {
    const shown = Math.min(n, 5);
    let s = '';
    for (let i = 0; i < shown; i++) s += `<circle class="d-dot" cx="${26 + i * 40}" cy="54" r="13"/><text class="d-t d-dark" x="${26 + i * 40}" y="58" text-anchor="middle">${n > 5 && i === shown - 1 ? n : i + 1}</text>`;
    const x = 26 + shown * 40;
    s += `<circle class="d-block" cx="${x}" cy="54" r="13"/><path class="d-x" d="M${x - 5} 49l10 10M${x + 5} 49l-10 10"/>`;
    return svg(`${s}<text class="d-t d-muted" x="14" y="100">${n} trades allowed · the next new order is blocked</text>`);
  },

  lossStreak: ({ streak: n }) => {
    let s = '<line class="d-zero" x1="14" y1="58" x2="246" y2="58"/>';
    s += '<rect class="d-bar-g" x="22" y="30" width="26" height="28" rx="3"/>';
    const losses = Math.min(n, 5);
    for (let i = 0; i < losses; i++) s += `<rect class="d-bar-r" x="${62 + i * 36}" y="58" width="26" height="${20 + (i % 2) * 8}" rx="3"/>`;
    const x = 62 + losses * 36;
    s += `<text class="d-t d-red-t" x="${x}" y="54">stop</text>`;
    return svg(`${s}<text class="d-t d-muted" x="14" y="108">${n} losing trades in a row → exit and stop for the day</text>`);
  },

  giveback: ({ pct, armAt }) => {
    const peakY = 22, zeroY = 92, levelY = peakY + (zeroY - peakY) * (pct / 100);
    return svg(`
      <line class="d-zero" x1="14" y1="${zeroY}" x2="246" y2="${zeroY}"/><text class="d-t d-muted" x="244" y="${zeroY - 5}" text-anchor="end">₹0</text>
      <polyline class="d-line" points="14,${zeroY} 50,80 86,60 122,${peakY} 150,32 182,${levelY}"/>
      <circle class="d-dot" cx="122" cy="${peakY}" r="4"/><text class="d-t d-mint-t" x="132" y="${peakY + 3}">peak</text>
      <line class="d-amber d-dash" x1="122" y1="${levelY}" x2="246" y2="${levelY}"/>
      <text class="d-t d-amber-t" x="196" y="${levelY - 6}">−${pct}%</text>
      <circle class="d-hit-red" cx="182" cy="${levelY}" r="5"/><text class="d-t d-red-t" x="174" y="${levelY + 18}">exit</text>
      <text class="d-t d-muted" x="14" y="112">Starts once booked profit reaches ${esc(armAt)}</text>`);
  },

  cutoff: ({ time }) => {
    const [h, m] = time.split(':').map(Number);
    const start = 9 * 60 + 15, end = 15 * 60 + 30, mins = h * 60 + m;
    const x = 20 + ((mins - start) / (end - start)) * 220;
    return svg(`
      <rect class="d-open" x="20" y="44" width="${x - 20}" height="18" rx="4"/>
      <rect class="d-closed" x="${x}" y="44" width="${240 - x}" height="18" rx="4"/>
      <line class="d-amber" x1="${x}" y1="32" x2="${x}" y2="74"/>
      <text class="d-t d-amber-t" x="${x}" y="26" text-anchor="middle">${label12(time)} cutoff</text>
      <text class="d-t d-muted" x="20" y="90">9:15</text><text class="d-t d-muted" x="240" y="90" text-anchor="end">3:30</text>
      <text class="d-t d-mint-t" x="24" y="57">new trades OK</text>
      <text class="d-t d-muted" x="14" y="112">After the cutoff: no new entries. Open trades stay.</text>`);
  },

  optionSl: ({ slPct, perTrade }) => {
    const slY = 26 + Math.min(70, slPct * 1.4), stop = Math.round((100 - slPct) * 100) / 100;
    return svg(`
      <line class="d-mint" x1="14" y1="26" x2="246" y2="26"/><text class="d-t d-mint-t" x="16" y="20">Buy ₹100</text>
      <line class="d-red d-dash" x1="14" y1="${slY}" x2="246" y2="${slY}"/><text class="d-t d-red-t" x="16" y="${slY + 14}">SL ₹${stop} (−${slPct}%)</text>
      <polyline class="d-line" points="14,26 60,34 100,30 140,${(26 + slY) / 2} 190,${slY}"/>
      <circle class="d-hit-red" cx="190" cy="${slY}" r="5"/>
      <text class="d-t d-muted" x="14" y="112">lots = ${esc(perTrade)} ÷ (₹${Math.round(slPct * 100) / 100} × lot size)</text>`);
  },

  killSwitch: ({ broker }) => svg(`
    <rect class="d-phone" x="28" y="10" width="58" height="96" rx="10"/>
    <rect class="d-lockbody" x="44" y="54" width="26" height="20" rx="4"/><path class="d-locktop" d="M49 54v-7a8 8 0 0 1 16 0v7"/>
    <text class="d-t d-muted" x="57" y="98" text-anchor="middle">${esc(broker)} app</text>
    <text class="d-t" x="104" y="40">A limit is hit →</text>
    <text class="d-t d-red-t" x="104" y="60">${esc(broker)} account locked</text>
    <text class="d-t d-muted" x="104" y="80">until the next trading day,</text>
    <text class="d-t d-muted" x="104" y="96">even in the ${esc(broker)} app.</text>`),
};

const TEXT = {
  maxLoss: 'If your day’s P&L (booked + open) falls to this level, TradeLock exits every position and stops you for the day.',
  profitLock: 'Lock in a good day: once your P&L reaches the target, TradeLock stops new trades for the day.',
  maxTrades: 'Counts your entries. When the limit is used up, new orders are paused; exits always work.',
  lossStreak: 'Counts closed trades. That many losses in a row means you are tilting, so TradeLock exits and stops you.',
  giveback: 'Protects profit you already booked. If the day falls this far from its best point, TradeLock exits and stops you.',
  cutoff: 'Avoids late, rushed trades. After this time no new entries are allowed; your open trades and their stop-losses stay.',
  killSwitch: 'Uses your broker’s own kill switch, so you cannot trade from the broker app either after a limit is hit.',
  optionSl: 'Power Scalper sizes every option buy so that a fall of this much in the premium loses at most your per-trade budget (daily stop-loss ÷ trades per day). Lots follow the live premium; you never type them.',
};

/** The (i) button with its pop-up. `v` carries the numbers to draw. */
const OPEN_UP = new Set(['cutoff', 'killSwitch']);

export function ruleTip(key, v) {
  return html`<span class="rinfo algo-info ${OPEN_UP.has(key) ? 'up' : ''}" tabindex="0" role="button" aria-label="How it works">i
    <span class="tip" role="tooltip">${DIAGRAMS[key](v)}<span class="tip-text">${TEXT[key]}</span></span></span>`;
}

export const tipValues = (f, capital, limitOf, broker) => ({
  sl: limitOf(f.maxLoss, capital) != null ? `−${inr(limitOf(f.maxLoss, capital))}` : `${f.maxLoss.value}${f.maxLoss.mode === 'percent' ? '%' : ''}`,
  target: limitOf(f.profitLock, capital) != null ? `+${inr(limitOf(f.profitLock, capital))}` : `${f.profitLock.value}${f.profitLock.mode === 'percent' ? '%' : ''}`,
  n: f.maxTrades.value,
  streak: f.lossStreak.value,
  pct: f.giveback.value,
  armAt: limitOf(f.maxLoss, capital) != null ? inr(limitOf(f.maxLoss, capital)) : 'your stop-loss amount',
  time: f.cutoff.value,
  broker,
  slPct: f.optionSl?.value ?? 20,
  perTrade: limitOf(f.maxLoss, capital) != null && f.maxTrades.value > 0 ? inr(limitOf(f.maxLoss, capital) / f.maxTrades.value) : 'per-trade budget',
});
