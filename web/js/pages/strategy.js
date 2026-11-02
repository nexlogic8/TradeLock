import { html, $, on, raw } from '../core/dom.js';
import { get, post, put, del } from '../core/api.js';
import { builtInFor } from './strategy-library.js';
import { store } from '../core/store.js';
import { artInfo } from './strategy-art.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';

const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entries = [
  ['vwap', 'VWAP alignment', 'Require price to hold on the selected side of VWAP.'],
  ['ema', 'EMA trend confirmation', 'Confirm direction with a fast and slow EMA.'],
  ['rsi', 'RSI momentum', 'Use RSI momentum as an additional confirmation.'],
  ['breakout', 'Range breakout', 'Look for a move beyond the recent range.'],
  ['volume', 'Volume confirmation', 'Require volume to exceed its recent average.'],
];
const timeframes = [['1m','1 minute'],['3m','3 minutes'],['5m','5 minutes'],['15m','15 minutes'],['day','Daily']];
const timeLabel = value => { const [h,m] = value.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`; };

function toggle(key, checked) {
  return html`<button class="switch" type="button" role="switch" aria-checked="${checked}" aria-label="${key}" data-entry="${key}"></button>`;
}

function select(id, value, options, label) {
  return html`<select class="input" id="${id}" data-field="${id}" aria-label="${label}">${options.map(([v,l]) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`)}</select>`;
}

const meta = f => `${f.market === 'fo' ? 'Futures & options' : 'Equity'} · ${timeframes.find(([v]) => v === f.timeframe)?.[1] || f.timeframe} · ${f.direction === 'both' ? 'Long & short' : f.direction === 'long' ? 'Long only' : 'Short only'}`;
const exitsText = x => `SL ${x.stopValue}${x.stopMode === 'percent' ? '%' : ' ₹'} → target ${x.targetValue}${x.targetMode === 'rr' ? 'R' : '%'}${x.trailing ? ` · trailing ${x.trailValue}%` : ''} · square-off ${x.squareOff}`;

// Built-in strategy card: what it does and whether it is running.
function builtInCard(b, live) {
  const a = live?.account;
  const status = !b.auto ? ['Chart signal', 'ice'] : !a ? ['Algo Trading', 'grey']
    : a[b.flag] ? [a.algoOn ? 'Algo Trading · On' : 'On · Algo Trading stopped', a.algoOn ? '' : 'amber'] : ['Off', 'grey'];
  return html`<article class="panel pad strat-builtin">
    <header><div><b>${b.name}</b><small>${b.tag} · ${b.timeframe}</small></div><span class="strat-builtin-tools"><span class="pill sm ${status[1]}">${status[0]}</span>${b.public ? '' : raw(artInfo(b.key, b.name))}</span></header>
    <dl class="algo-rules">${b.rules.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
  </article>`;
}

function myStrategyCard(item, confirming) {
  const filters = entries.filter(([k]) => item.entries?.[k]).map(([, label]) => label);
  return html`<article class="panel pad strat-mine">
    <div class="strat-mine-copy"><b>${item.name}</b><small>${meta(item)}</small>
      <span>${filters.length ? filters.join(' · ') : 'No entry filters'}</span><span>${exitsText(item.exits)}</span></div>
    <div class="strat-mine-actions">
      <a class="btn btn-ghost btn-sm" href="/backtest" data-nav="backtest" data-backtest="${item.id}">${icon('chart')}Backtest</a>
      <button class="btn btn-ghost btn-sm" type="button" data-edit="${item.id}">${icon('sliders')}Edit</button>
      <button class="btn btn-sm ${confirming ? 'btn-danger' : 'btn-danger-ghost'}" type="button" data-delete="${item.id}">${confirming ? 'Delete?' : 'Delete'}</button>
    </div>
  </article>`;
}

export default {
  title: 'Strategy',
  sub: 'Built-in strategies and your own playbooks',
  layout: 'app',
  auth: true,

  async load(ctx) {
    const [list, live] = await Promise.all([get('/strategies'), get('/algo/live').catch(() => null)]);
    ctx.ui.editing = ctx.ui.editing ?? null;
    ctx.ui.error = '';
    return { ...list, live };
  },

  view(ctx) {
    const d = ctx.data, editing = ctx.ui.editing, admin = !!store.get().user?.admin;   // users: the public Gap card only
    const list = html`
      <section class="strat-section">
        <div class="strat-section-head"><div><h3>Built-in strategies</h3><p>${admin ? 'Exactly how TradeLock runs them today. ORB 5m and EMA 9/21 trade automatically when switched on in AI Algo Trading.'
          : 'Runs automatically when switched on in AI Algo Trading.'}</p></div>
          <a class="btn btn-ghost btn-sm" href="/algo" data-nav="algo">${icon('spark')}AI Algo Trading</a></div>
        <div class="strat-builtin-grid">${builtInFor(admin).map(b => builtInCard(b, d.live))}</div>
      </section>
      <section class="strat-section">
        <div class="strat-section-head"><div><h3>My strategies</h3><p>Your own playbooks: saved privately, for planning and review. They are not traded automatically.</p></div>
          <button class="btn btn-primary btn-sm" type="button" data-new ${editing ? 'disabled' : ''}>${icon('plus')}New strategy</button></div>
        ${d.items.length ? html`<div class="strat-mine-list">${d.items.map(item => myStrategyCard(item, ctx.ui.confirmDelete === item.id))}</div>`
          : html`<div class="panel pad strat-empty">No saved strategies yet. Create one to write down your setup, entries and exits.</div>`}
      </section>`;
    if (!editing) return list;
    const f = ctx.ui.form;
    const x = f.exits;
    const active = entries.filter(([key]) => f.entries[key]).map(([,label]) => label);
    const stopText = `${x.stopValue}${x.stopMode === 'percent' ? '%' : ' ₹'}`;
    const targetText = `${x.targetValue}${x.targetMode === 'rr' ? 'R' : '%'}`;
    return html`${list}
      <h3 class="strat-editor-title" id="strategy-editor">${editing === 'new' ? 'New strategy' : `Edit · ${ctx.ui.saved.name}`}</h3>
      <div class="strategy-layout">
        <div class="strategy-main">
          <section class="panel pad strategy-card">
            <div class="strategy-section-head"><span class="strategy-step">01</span><div><h3>Strategy identity</h3><p>Name your playbook and set the market context.</p></div><span class="pill sm grey">PROFILE</span></div>
            <div class="strategy-fields">
              <label class="strategy-field strategy-field-wide"><span>Strategy name</span><input class="input" data-field="name" maxlength="48" value="${f.name}" placeholder="e.g. Opening range momentum"></label>
              <label class="strategy-field"><span>Market</span>${select('market', f.market, [['equity','Equity'],['fo','Futures & options']], 'Market')}</label>
              <label class="strategy-field"><span>Chart timeframe</span>${select('timeframe', f.timeframe, timeframes, 'Chart timeframe')}</label>
              <div class="strategy-field strategy-field-wide"><span>Trade direction</span><div class="seg strategy-seg" role="group" aria-label="Trade direction">${[['long','Long'],['short','Short'],['both','Long & short']].map(([v,l]) => html`<button type="button" data-direction="${v}" aria-pressed="${f.direction === v}">${l}</button>`)}</div></div>
            </div>
          </section>

          <section class="panel pad strategy-card">
            <div class="strategy-section-head"><span class="strategy-step">02</span><div><h3>Entry confirmations</h3><p>Choose the conditions you want to see before entering a trade.</p></div><span class="pill sm ice">${active.length} SELECTED</span></div>
          <div class="strategy-entry-list">${entries.map(([key,label,description]) => html`<div class="strategy-entry-wrap ${f.entries[key] ? 'selected' : ''}"><div class="strategy-entry"><span class="strategy-entry-icon">${icon(key === 'vwap' ? 'chart' : key === 'ema' ? 'radar' : key === 'rsi' ? 'gauge' : key === 'breakout' ? 'arrow' : 'list')}</span><span class="strategy-entry-copy"><b>${label}</b><small>${description}</small></span>${toggle(key, f.entries[key])}</div>${f.entries[key] && key !== 'vwap' ? html`<div class="strategy-entry-options">${key === 'ema' ? html`<label>Fast EMA<input class="input" data-entry-field="emaFast" inputmode="numeric" value="${f.entries.emaFast}"></label><label>Slow EMA<input class="input" data-entry-field="emaSlow" inputmode="numeric" value="${f.entries.emaSlow}"></label>` : key === 'rsi' ? html`<label>Minimum RSI<input class="input" data-entry-field="rsiMin" inputmode="decimal" value="${f.entries.rsiMin}"></label>` : key === 'breakout' ? html`<label>Lookback bars<input class="input" data-entry-field="breakoutBars" inputmode="numeric" value="${f.entries.breakoutBars}"></label>` : html`<label>Volume vs average<input class="input" data-entry-field="volumeMultiple" inputmode="decimal" value="${f.entries.volumeMultiple}"></label>`}</div>` : ''}</div>`)}</div>
            <p class="strategy-footnote">Conditions are a planning checklist. Indicator values and signal detection are not connected to the broker.</p>
          </section>

          <section class="panel pad strategy-card">
            <div class="strategy-section-head"><span class="strategy-step">03</span><div><h3>Exit framework</h3><p>Predefine how you plan to protect capital and take profit.</p></div><span class="pill sm">RISK FIRST</span></div>
            <div class="strategy-exit-grid">
              <label class="strategy-field"><span>Stop-loss type</span>${select('stopMode', x.stopMode, [['percent','Percentage'],['amount','Fixed amount']], 'Stop-loss type')}</label>
              <label class="strategy-field"><span>${x.stopMode === 'percent' ? 'Stop distance' : 'Stop amount'}</span><div class="input-wrap"><span class="affix">${x.stopMode === 'percent' ? '%' : '₹'}</span><input class="input" data-field="stopValue" inputmode="decimal" min="0.1" step="0.1" value="${x.stopValue}" aria-label="Stop distance"></div></label>
              <label class="strategy-field"><span>Profit target type</span>${select('targetMode', x.targetMode, [['rr','Risk / reward'],['percent','Percentage']], 'Profit target type')}</label>
              <label class="strategy-field"><span>${x.targetMode === 'rr' ? 'Target multiple' : 'Target move'}</span><div class="input-wrap"><span class="affix">${x.targetMode === 'rr' ? 'R' : '%'}</span><input class="input" data-field="targetValue" inputmode="decimal" min="0.1" step="0.1" value="${x.targetValue}" aria-label="Profit target"></div></label>
              <div class="strategy-trailing"><div class="strategy-trailing-copy"><b>Trailing stop</b><small>Move the stop as price moves in your favour.</small></div><button class="switch" type="button" role="switch" aria-checked="${x.trailing}" aria-label="Trailing stop" data-trailing></button><label class="input-wrap strategy-trail-input"><span class="affix">%</span><input class="input" data-field="trailValue" inputmode="decimal" min="0.1" step="0.1" value="${x.trailValue}" aria-label="Trailing distance" ${x.trailing ? '' : 'disabled'}></label></div>
              <label class="strategy-field"><span>Planned square-off</span>${select('squareOff', x.squareOff, ['14:45','15:00','15:10','15:15','15:20','15:25'].map(t => [t,timeLabel(t)]), 'Planned square-off')}</label>
            </div>
          </section>

          <div class="panel savebar strategy-savebar"><div class="msg" id="strategy-save-msg">${ctx.ui.error ? html`<span class="neg">${ctx.ui.error}</span>` : 'Saved privately to your account.'}</div><button class="btn btn-ghost btn-sm" id="strategy-discard">Cancel</button><button class="btn btn-primary" id="strategy-save" ${editing !== 'new' && same(f,ctx.ui.saved) ? 'disabled' : ''}>${icon('check')}${editing === 'new' ? 'Create strategy' : 'Save changes'}</button></div>
        </div>

        <aside class="strategy-aside">
          <div class="panel pad strategy-preview"><div class="panel-head"><h3 class="panel-title">${icon('radar')}Playbook preview</h3><span class="strategy-live-dot"><i></i> READY</span></div><div class="strategy-preview-name" id="strategy-preview-name">${f.name || 'Untitled strategy'}</div><div class="strategy-preview-meta" id="strategy-preview-meta">${f.market === 'fo' ? 'Futures & options' : 'Equity'} <span>·</span> ${timeframes.find(([v]) => v === f.timeframe)?.[1]} <span>·</span> ${f.direction === 'both' ? 'Long & short' : f.direction === 'long' ? 'Long only' : 'Short only'}</div><div class="strategy-preview-rule"><span>ENTRY FILTERS</span><b id="strategy-preview-entry-count">${active.length || 'None selected'}</b><small id="strategy-preview-entry-list">${active.length ? active.join(' · ') : 'Add at least one confirmation to complete your playbook.'}</small></div><div class="strategy-preview-rule"><span>STOP / TARGET</span><b id="strategy-preview-exits">${stopText} <i>→</i> ${targetText}</b><small id="strategy-preview-exit-note">${x.trailing ? `Trailing stop ${x.trailValue}% enabled` : 'Trailing stop off'} · square-off ${timeLabel(x.squareOff)}</small></div><div class="strategy-risk-note">${icon('shield')}<span><b>Protection stays separate</b><small>Your Risk rules and broker kill switch continue to govern order safety.</small></span></div></div>
          <div class="panel pad strategy-aside-note"><span class="strategy-note-icon">${icon('spark')}</span><h3>Built for discipline.</h3><p>A good playbook defines the setup, risk and exit before a position is opened.</p><a href="/rules" data-nav="rules">Review Risk rules ${icon('arrow')}</a></div>
        </aside>
      </div>`;
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    on(el, 'click', '[data-entry]', (_, b) => { ui.form.entries[b.dataset.entry] = !ui.form.entries[b.dataset.entry]; ctx.paint(); }, signal);
    on(el, 'click', '[data-trailing]', () => { ui.form.exits.trailing = !ui.form.exits.trailing; ctx.paint(); }, signal);
    on(el, 'input', '[data-entry-field]', (_, field) => { ui.form.entries[field.dataset.entryField] = Number(field.value) || 0; syncSave(ctx); }, signal);
    on(el, 'click', '[data-direction]', (_, b) => { ui.form.direction = b.dataset.direction; ctx.paint(); }, signal);
    on(el, 'change', '[data-field]', (_, field) => {
      const key = field.dataset.field;
      if (key === 'name' || key === 'market' || key === 'timeframe') ui.form[key] = field.value;
      else if (key === 'stopMode' || key === 'targetMode' || key === 'squareOff') { ui.form.exits[key] = field.value; ctx.paint(); return; }
      else if (['stopValue','targetValue','trailValue'].includes(key)) ui.form.exits[key] = Number(field.value);
      syncSave(ctx);
    }, signal);
    on(el, 'input', '[data-field="name"], [data-field="stopValue"], [data-field="targetValue"], [data-field="trailValue"]', (_, field) => {
      const key = field.dataset.field;
      if (key === 'name') ui.form.name = field.value;
      else ui.form.exits[key] = Number(field.value) || 0;
      syncSave(ctx);
    }, signal);
    const openEditor = (id, form) => {
      ui.editing = id; ui.form = clone(form); ui.saved = clone(form); ui.error = ''; ui.confirmDelete = null; ctx.paint();
      requestAnimationFrame(() => $('#strategy-editor', el)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
    on(el, 'click', '[data-art-info]', (e, b) => {
      e.stopPropagation();
      const anchor = b.closest('.sart-anchor'), open = !anchor.classList.contains('open');
      el.querySelectorAll('.sart-anchor.open').forEach(a => a.classList.remove('open'));
      anchor.classList.toggle('open', open);
    }, signal);
    document.addEventListener('click', e => { if (!e.target.closest('.sart-anchor')) el.querySelectorAll('.sart-anchor.open').forEach(a => a.classList.remove('open')); }, { signal });
    on(el, 'click', '[data-new]', () => openEditor('new', { ...clone(ctx.data.template), name: 'New strategy' }), signal);
    // Backtest: the Backtest page opens with this strategy chosen (read once there).
    on(el, 'click', '[data-backtest]', (_, b) => { try { sessionStorage.setItem('tradelock.backtest.strategy', b.dataset.backtest); } catch { /* private window */ } }, signal);
    on(el, 'click', '[data-edit]', (_, b) => {
      const item = ctx.data.items.find(i => i.id === Number(b.dataset.edit));
      if (!item) return;
      const { id, createdAt, updatedAt, ...form } = item;
      openEditor(id, form);
    }, signal);
    on(el, 'click', '[data-delete]', async (_, b) => {
      const id = Number(b.dataset.delete);
      if (ui.confirmDelete !== id) {   // first click arms, second click (within 5 s) deletes
        ui.confirmDelete = id; ctx.paint();
        clearTimeout(ui.deleteTimer); ui.deleteTimer = setTimeout(() => { ui.confirmDelete = null; ctx.paint(); }, 5000);
        return;
      }
      ui.confirmDelete = null;
      try {
        await del(`/strategies/${id}`);
        if (ui.editing === id) ui.editing = null;
        ctx.data = { ...ctx.data, items: ctx.data.items.filter(i => i.id !== id) };
        toast('Strategy deleted.', 'ok'); ctx.paint();
      } catch (e) { toastError(e); }
    }, signal);
    on(el, 'click', '#strategy-discard', () => { ui.editing = null; ui.error = ''; ctx.paint(); }, signal);
    on(el, 'click', '#strategy-save', async (_, button) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const created = ui.editing === 'new';
        const { strategy } = created ? await post('/strategies', { strategy: ui.form }) : await put(`/strategies/${ui.editing}`, { strategy: ui.form });
        ctx.data = { ...ctx.data, items: [strategy, ...ctx.data.items.filter(i => i.id !== strategy.id)] };
        ui.editing = null; ui.error = '';
        toast(created ? 'Strategy created.' : 'Strategy saved.', 'ok');
      } catch (e) { ui.error = e.message; button.disabled = false; }
      ctx.paint();
    }, signal);
  },
};

function syncSave(ctx) {
  const save = $('#strategy-save', ctx.el), reset = $('#strategy-discard', ctx.el);
  if (!save) return;
  const dirty = !same(ctx.ui.form, ctx.ui.saved);
  save.disabled = ctx.ui.editing !== 'new' && !dirty;
  const f = ctx.ui.form, x = f.exits;
  $('#strategy-preview-name', ctx.el).textContent = f.name || 'Untitled strategy';
  $('#strategy-preview-meta', ctx.el).innerHTML = `${f.market === 'fo' ? 'Futures & options' : 'Equity'} <span>·</span> ${timeframes.find(([v]) => v === f.timeframe)?.[1]} <span>·</span> ${f.direction === 'both' ? 'Long & short' : f.direction === 'long' ? 'Long only' : 'Short only'}`;
  const active = entries.filter(([key]) => f.entries[key]).map(([, label]) => label);
  $('#strategy-preview-entry-count', ctx.el).textContent = active.length || 'None selected';
  $('#strategy-preview-entry-list', ctx.el).textContent = active.length ? active.join(' · ') : 'Add at least one confirmation to complete your playbook.';
  $('#strategy-preview-exits', ctx.el).innerHTML = `${x.stopValue}${x.stopMode === 'percent' ? '%' : ' ₹'} <i>→</i> ${x.targetValue}${x.targetMode === 'rr' ? 'R' : '%'}`;
  $('#strategy-preview-exit-note', ctx.el).textContent = `${x.trailing ? `Trailing stop ${x.trailValue}% enabled` : 'Trailing stop off'} · square-off ${timeLabel(x.squareOff)}`;
}
