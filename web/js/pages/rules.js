import { html, $, on } from '../core/dom.js';
import { get, put } from '../core/api.js';
import { inr, int, longDay } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { formError } from '../ui/parts.js';
import { ruleTip, tipValues } from '../ui/ruletips.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';

const DEFAULT_PCT = { maxLoss: 5, profitLock: 10, capitalUse: 80 };
const CUTOFFS = ['14:30', '14:45', '15:00', '15:10', '15:15', '15:20'];
const clone = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label12 = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} PM`; };

/** Same rule as the server (rules/limits.js): percent of starting capital, or a fixed amount. */
const limitOf = (r, capital) => (r.mode !== 'percent' ? r.value : capital > 0 ? Math.round(capital * r.value) / 100 : null);

/** One rule = one row: name and a short line · the single value to set · switch on the right. */
function row(key, title, line, r, input, tv) {
  return html`
    <div class="srule ${r.on ? 'on' : 'off'} ${input ? '' : 'no-input'}">
      <div class="srule-head">
        <div class="srule-main">
          <span class="srule-text"><b>${title}</b><small id="line-${key}">${line}</small></span>
          ${input ? html`<div class="srule-input">${input}</div>` : ''}
        </div>
        ${ruleTip(key, tv)}
        <button class="switch" type="button" role="switch" aria-checked="${r.on}" aria-label="${title}" data-toggle="${key}"></button>
      </div>
    </div>`;
}

/** Start / Stop Protection, like Start / Stop Algo Trading: the same switch as "Protection" in the top bar. */
function protCard(d, f, set = 'manual') {
  const broker = d?.broker, label = broker?.label || 'broker', running = !!broker && broker.agentOn !== false;
  // Option SL room sizes manual Power Scalper orders only: not a rule of the Algo Trading set.
  const keys = ['maxLoss', 'capitalUse', 'profitLock', 'maxTrades', 'lossStreak', 'giveback', ...(set === 'algo' ? [] : ['optionSl']), 'cutoff', 'killSwitch'];
  const on = keys.filter(k => f?.[k]?.on).length;
  const locked = running && d?.agentLock;
  const state = !broker ? ['Not connected', 'grey'] : locked ? ['Locked today', 'amber'] : running ? ['Protecting', ''] : ['Stopped', 'ice'];
  const text = !broker ? 'Connect a broker so TradeLock can watch your trades against these rules.'
    : locked ? html`Today ${d.agentLock}, so protection stays on until the next trading day: it can't be used to get around your own limits.`
    : running ? html`Watching your <b>${label}</b> positions every few seconds. When a limit below is hit, TradeLock acts at once.`
    : html`<b>Your rules are not enforced.</b> Trades are not watched and nothing is exited automatically.`;
  return html`
    <section class="panel pad algo-control prot-control ${running ? 'running' : ''}" id="prot-card">
      <div class="algo-control-copy">
        <span class="pill ${state[1]}"><span class="dot ${running && d?.marketOpen ? 'pulse' : ''}"></span>${state[0]}</span>
        <h2>Protection</h2>
        <p>${text} <span class="prot-count">${on} of ${keys.length} rules on.</span></p>
      </div>
      ${locked ? html`<button class="btn btn-ghost algo-start prot-locked" type="button" data-prot="locked">${icon('lock')}Locked until next trading day</button>`
        : html`<button class="btn ${running ? 'btn-danger' : 'btn-primary'} algo-start" type="button" data-prot="${running ? 'stop' : 'start'}" ${broker ? '' : 'disabled'}>
        ${icon(running ? 'stop' : 'play')}${running ? 'Stop Protection' : 'Start Protection'}</button>`}
    </section>`;
}

/** Money value with a compact % / ₹ switch. */
function moneyInput(key, r) {
  const pct = r.mode === 'percent';
  return html`
    <div class="seg seg-sm" role="group" aria-label="Amount type">
      <button type="button" data-mode="${key}:percent" aria-pressed="${pct}">%</button>
      <button type="button" data-mode="${key}:amount" aria-pressed="${!pct}">₹</button>
    </div>
    <div class="input-wrap"><span class="affix">${pct ? '%' : '₹'}</span>
      <input class="input" id="v-${key}" data-value="${key}" inputmode="decimal" value="${pct ? r.value : int(r.value)}" aria-label="${key}"></div>`;
}

const countInput = (key, r, unit) => html`
  <div class="input-wrap"><input class="input" id="v-${key}" data-value="${key}" inputmode="numeric" value="${int(r.value)}" aria-label="${unit}"><span class="suffix">${unit}</span></div>`;

/** Rupee equivalent for the short line under a money rule. */
const amountText = (r, capital) => {
  const v = limitOf(r, capital);
  return v == null ? 'your limit (amount set once today’s capital is known)' : r.mode === 'percent' ? `${inr(v)} today` : inr(v);
};

const shortAmount = (r, c) => { const v = limitOf(r, c); return v == null ? 'your limit' : inr(v); };
const LINES = {
  maxLoss: (f, c) => `Exit all at −${shortAmount(f.maxLoss, c)} today`,
  capitalUse: (f, c) => `Use at most ${shortAmount(f.capitalUse, c)} in one trade`,
  profitLock: (f, c) => `Stop for the day at +${shortAmount(f.profitLock, c)}`,
  maxTrades: () => 'Pause new orders after this many entries',
  lossStreak: () => 'Stop after this many losses in a row',
  giveback: () => 'Exit if profit falls this % from its peak',
  optionSl: f => `Stop ${f.optionSl.value}% below the option premium`,
  cutoff: () => 'No new entries after this time',
};

const SET_NAMES = { manual: 'Manual trading', algo: 'Algo Trading' };

/** The set in force now: Algo Trading on (with protection) → Algo rules, else Manual rules (server: rules/service.js). */
const modeNow = ctx => {
  const b = ctx.state.dash?.broker;
  return b ? (b.algoOn && b.agentOn !== false ? 'algo' : 'manual') : ctx.data.mode || 'manual';
};

/** Manual | Algo switch: which rule set is being edited, and which one protects the account now. */
function setSwitch(ctx) {
  const set = ctx.ui.set, now = modeNow(ctx), live = set === now;
  return html`
    <div class="rule-sets" id="rule-sets">
      <div class="seg" role="group" aria-label="Rule set">
        ${['manual', 'algo'].map(k => html`<button type="button" data-set="${k}" aria-pressed="${set === k}">${SET_NAMES[k]}${now === k ? html` <span class="pill sm">Active now</span>` : ''}</button>`)}
      </div>
      <p class="muted small" id="rule-set-note">${live
        ? html`These rules protect your account now${now === 'algo' ? ': Algo Trading is on.' : ': Algo Trading is off.'}`
        : html`<b>Not in force now.</b> These apply when Algo Trading is switched ${set === 'algo' ? 'on' : 'off'}; edits are saved for then.`}</p>
    </div>`;
}

function killLine(d) {
  const ks = d?.killSwitch;
  if (ks?.activeAt || ks?.broker?.active === true) return html`<span class="neg">Locked today</span> · unlocks next trading day`;
  if (ks?.armed) return html`<span class="warn">Armed</span> · locks once all positions are closed`;
  return `Also lock the ${d?.broker?.label || 'broker'} app when a limit hits`;
}

export default {
  title: 'Risk rules',
  sub: 'Set clear limits before your trading session begins',
  layout: 'app',
  auth: true,

  async load(ctx) {
    const data = await get('/rules');
    // Two sets (Manual trading / Algo Trading); the page opens on the one in force.
    ctx.ui.forms = { manual: withDefaults(data.manual || data.active), algo: withDefaults(data.algo || data.active) };
    ctx.ui.set = ctx.ui.set || data.mode || 'manual';
    ctx.ui.form = ctx.ui.forms[ctx.ui.set];
    ctx.ui.error = null;
    return data;
  },

  view(ctx) {
    const f = ctx.ui.form;
    const capital = ctx.state.dash?.capital ?? ctx.data.capital;
    const d = ctx.state.dash;
    const broker = d?.broker?.label || 'broker';
    const tv = tipValues(f, capital, limitOf, broker);   // numbers for the (i) diagrams
    return html`
      ${protCard(d, f, ctx.ui.set)}
      ${ctx.data.pending ? html`<div class="banner amber mb" id="rules-pending">${icon('clock')}<div><b>Changes scheduled for ${longDay(ctx.data.pendingFrom)}.</b> You loosened a limit during market hours, so the new rules start next session.</div></div>` : ''}
      <div class="panel pad srules">
        ${setSwitch(ctx)}
        <div class="srules-head"><span class="muted small">Starting capital today</span><span class="srules-save" id="save-msg" aria-live="polite"></span><b class="num">${capital > 0 ? inr(capital) : 'not known yet'}</b></div>
        ${row('maxLoss', 'Daily stop‑loss', LINES.maxLoss(f, capital), f.maxLoss, moneyInput('maxLoss', f.maxLoss), tv)}
        ${row('capitalUse', 'Capital per trade', LINES.capitalUse(f, capital), f.capitalUse, moneyInput('capitalUse', f.capitalUse), tv)}
        ${row('profitLock', 'Profit target', LINES.profitLock(f, capital), f.profitLock, moneyInput('profitLock', f.profitLock), tv)}
        ${row('maxTrades', 'Trades per day', LINES.maxTrades(), f.maxTrades, countInput('maxTrades', f.maxTrades, 'trades'), tv)}
        ${row('lossStreak', 'Losing streak', LINES.lossStreak(), f.lossStreak, countInput('lossStreak', f.lossStreak, 'losses'), tv)}
        ${row('giveback', 'Profit give-back', LINES.giveback(f, capital), f.giveback,
          html`<div class="input-wrap"><span class="affix">%</span><input class="input" id="v-giveback" data-value="giveback" inputmode="numeric" value="${f.giveback.value}" aria-label="Give-back percent"></div>`, tv)}
        ${ctx.ui.set === 'algo' ? '' : row('optionSl', 'Option SL room', LINES.optionSl(f, capital), f.optionSl,
          html`<div class="input-wrap"><span class="affix">%</span><input class="input" id="v-optionSl" data-value="optionSl" inputmode="decimal" value="${f.optionSl.value}" aria-label="Option stop-loss room percent"></div>`, tv)}
        ${row('cutoff', 'Cutoff time', LINES.cutoff(), f.cutoff,
          html`<select class="input num" id="v-cutoff" data-cutoff aria-label="Cutoff time">${[...new Set([...CUTOFFS, f.cutoff.value])].sort().map(t => html`<option value="${t}" ${f.cutoff.value === t ? 'selected' : ''}>${label12(t)}</option>`)}</select>`, tv)}
        ${row('killSwitch', `${broker} kill switch`, killLine(d), f.killSwitch, '', tv)}
      </div>
      <div class="mt-s" id="rules-error">${formError(ctx.ui.error)}</div>`;
  },

  onStore(ctx, patch) {
    if (!patch.dash) return;
    const ks = $('#line-killSwitch', ctx.el);
    if (ks) ks.innerHTML = String(killLine(patch.dash));
    const card = $('#prot-card', ctx.el);
    if (card) card.outerHTML = String(protCard(patch.dash, ctx.ui.form, ctx.ui.set));   // only the card: unsaved edits stay
    const sets = $('#rule-sets', ctx.el);
    if (sets) sets.outerHTML = String(setSwitch(ctx));   // Algo switched on / off: "Active now" moves
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const capital = () => ctx.state.dash?.capital ?? ctx.data.capital;
    // Every change is saved by itself (no Save button): switches, % / ₹ and the cutoff at once, typed values
    // shortly after the last key. One save at a time; a change made meanwhile is saved right after.
    // Saves carry their set, so switching Manual / Algo mid-edit still saves the edit to the set it was made in.
    let timer = null, saving = false, again = null;
    const status = (text, cls = '') => { const m = $('#save-msg', el); if (m) { m.textContent = text; m.className = `srules-save ${cls}`; } };
    const save = async (set = ui.set) => {
      clearTimeout(timer); timer = null;
      if (saving) { again = set; return; }
      saving = true; status('Saving…');
      try {
        const res = await put('/rules', { rules: ui.forms[set], set });
        const hadPending = !!ctx.data.pending;
        ctx.data = res; ui.error = null;
        if (res.deferred) toast(`Saved. Looser limits start ${longDay(res.pendingFrom)}.`, 'warn');
        status('Saved', 'ok');
        // The pending banner comes or goes: repaint unless a value is being typed (that would drop the cursor).
        if (!!res.pending !== hadPending && !el.querySelector('[data-value]:focus')) ctx.paint();
        $('#rules-error', el).innerHTML = '';
        // Overview reads the rules from the live dashboard: refresh it now (the server also pushes it).
        get('/dashboard').then(dash => store.set({ dash })).catch(() => {});
      } catch (e) {
        ui.error = e.message; status('Not saved', 'neg');
        const box = $('#rules-error', el); if (box) box.innerHTML = String(formError(ui.error));
      } finally {
        saving = false;
        if (again) { const s = again; again = null; save(s); }
      }
    };
    const saveSoon = () => { clearTimeout(timer); status('Editing…'); timer = setTimeout(save, 900); };
    signal.addEventListener('abort', () => { if (timer) save(); }, { once: true });   // leaving mid-edit still saves
    on(el, 'click', '[data-set]', (_, b) => {
      if (b.dataset.set === ui.set) return;
      if (timer) save(ui.set);   // a typed value not saved yet goes to the set it was typed in
      ui.set = b.dataset.set; ui.form = ui.forms[ui.set];
      ctx.paint();
    }, signal);
    on(el, 'click', '[data-toggle]', (_, b) => { const r = ui.form[b.dataset.toggle]; r.on = !r.on; ctx.paint(); save(); }, signal);
    // Start / Stop Protection = the top-bar switch (it flips both at once and confirms with the server).
    on(el, 'click', '[data-prot]', () => document.getElementById('agent-btn')?.click(), signal);
    on(el, 'click', '[data-mode]', (_, b) => {
      const [key, mode] = b.dataset.mode.split(':');
      const r = ui.form[key];
      if (r.mode === mode) return;
      const cap = capital();
      // Convert so the rupee limit stays the same when capital is known.
      if (mode === 'percent') r.value = cap > 0 ? Math.max(0.1, Math.round((r.value / cap) * 1000) / 10) : DEFAULT_PCT[key];
      else r.value = cap > 0 ? Math.max(key === 'capitalUse' ? 1000 : 100, Math.round(limitOf(r, cap))) : key === 'maxLoss' ? 5000 : key === 'capitalUse' ? 50000 : 10000;
      r.mode = mode;
      ctx.paint(); save();
    }, signal);
    on(el, 'change', '[data-cutoff]', (_, s) => { ui.form.cutoff.value = s.value; save(); }, signal);
    on(el, 'input', '[data-value]', (_, i) => {
      const r = ui.form[i.dataset.value];
      const n = r.mode === 'percent' || i.dataset.value === 'optionSl' ? parseFloat(i.value.replace(/[^\d.]/g, '')) : Number(i.value.replace(/[^\d]/g, ''));
      r.value = Number.isFinite(n) ? n : 0;
      // Keep the rupee amounts in the short lines in step while typing (give-back follows the stop-loss).
      for (const k of ['maxLoss', 'capitalUse', 'profitLock', 'giveback', 'optionSl']) {
        const line = $(`#line-${k}`, el);
        if (line) line.textContent = LINES[k](ui.form, capital());
      }
      saveSoon();
    }, signal);
    on(el, 'focusout', '[data-value]', (_, i) => {
      const r = ui.form[i.dataset.value]; i.value = r.mode === 'percent' ? r.value : int(r.value);
      if (timer) save();   // done typing: save now
    }, signal);
  },
};

/** Saved rules with the defaults older accounts may lack. */
function withDefaults(rules) {
  const f = clone(rules);
  for (const k of ['maxLoss', 'profitLock']) f[k].mode ??= 'amount';
  f.killSwitch ??= { on: false };
  f.lossStreak ??= { on: false, value: 2 };
  f.giveback ??= { on: false, value: 20 };
  f.optionSl ??= { on: true, value: 20 };
  f.capitalUse ??= { on: false, mode: 'percent', value: 80 };
  delete f.giveback.minProfit;   // old setting: give-back now arms at the stop-loss amount
  return f;
}
