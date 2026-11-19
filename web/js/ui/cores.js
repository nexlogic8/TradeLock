// Animated emblems shared with the Android app: the AI core (AI Algo Trading) and the protection shield (Protection).
// Pages redraw on every live update, which would restart a CSS animation and make it jump. Each animation's phase is
// therefore taken from the clock (a negative animation-delay = how far into its cycle it is now), so a redraw lands
// exactly where the previous frame was and the motion stays continuous.
import { html, raw } from '../core/dom.js';
import { icon } from './icons.js';

/** CSS custom properties that put each named loop (period in ms) at the current point of its cycle. */
const phase = loops => Object.entries(loops).map(([name, ms]) => `--${name}:-${Date.now() % ms}ms`).join(';');

/**
 * The AI core: two aurora rings turning in opposite directions and a breathing glow while Algo Trading is on (faster
 * while the market is open); a still, dim ring when it is off.
 */
export function aiCore(running, live = false) {
  return html`<div class="ai-core ${running ? 'on' : ''} ${live ? 'live' : ''}" aria-hidden="true" style="${raw(phase({ 'spin-a': live ? 2400 : 6000, 'spin-b': live ? 1500 : 3750, breathe: 2800 }))}">
    <span class="ai-core-glow"></span><span class="ai-core-ring ai-core-a"></span><span class="ai-core-ring ai-core-b"></span>
    <span class="ai-core-center">${icon('spark')}</span>
  </div>`;
}

/**
 * The protection shield: a radar sweep turning around it and rings pulsing out while protection watches the account;
 * a dim, still shield when it is off. size: 'lg' (cards) or 'sm' (inline, e.g. a panel title).
 */
export function shieldCore(on, size = 'lg') {
  return html`<div class="shield-core ${on ? 'on' : ''} ${size}" aria-hidden="true" style="${raw(phase({ sweep: 3200, ping: 2400 }))}">
    <span class="shield-core-sweep"></span><span class="shield-core-ping"></span><span class="shield-core-ping p2"></span>
    <span class="shield-core-badge">${icon('shield')}</span>
  </div>`;
}
