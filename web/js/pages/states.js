import { html } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { pill } from '../ui/parts.js';

const STATES = [
  ['Connected', '', 'check', 'Fresh broker data and healthy monitoring. Rules are checked on every sync.', 'Dhan synced 2s ago · Monitoring active'],
  ['Degraded', 'amber', 'alert', 'Delayed sync or missing data. The UI must not imply that protection is active.', 'Last sync 48s ago · Rules cannot be checked'],
  ['Action pending', 'ice', 'clock', 'A broker command was sent and TradeLock is waiting for confirmation.', 'Exit order sent · waiting for Dhan'],
  ['Action failed', 'red', 'x', 'An exit or cancel failed. Show what happened and the next step clearly.', 'Exit rejected: freeze quantity. Exit manually in Dhan.'],
];

export default {
  title: 'Interaction states',
  sub: 'How TradeLock communicates system health and action results',
  layout: 'app',
  auth: true,

  view: () => html`
    <div class="halves">
      ${STATES.map(([name, t, ic, desc, demo]) => html`
        <div class="panel state-card">${pill(name, t, { dot: true, pulse: t === 'ice' })}<p>${desc}</p><div class="state-demo">${icon(ic)}${demo}</div></div>`)}
    </div>
    <div class="halves mt">
      <div class="panel pad"><h3 class="panel-title mb">Motion</h3><ul class="bullets"><li>160–240ms transitions on hover, page and panel changes</li><li>The reduced-motion setting turns all animation off</li><li>No animation on critical confirmations or action results</li></ul></div>
      <div class="panel pad"><h3 class="panel-title mb">Accessibility</h3><ul class="bullets"><li>Full keyboard navigation with visible focus rings</li><li>State shown by label and icon, never colour alone</li><li>Switches, radios and charts carry screen-reader labels</li></ul></div>
    </div>`,
};
