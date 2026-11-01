// Trading journal: a full-width table of trading days; new and existing entries open in a bottom sheet.
// The table, the tag bar and the sheet repaint independently, so typing never loses focus or scroll.
import { html, $, $$, on, debounce } from '../core/dom.js';
import { api, get, post, put } from '../core/api.js';
import { inr, tone, shortDay, ago } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';

export const MOODS = [['great', 'Great'], ['good', 'Good'], ['neutral', 'Neutral'], ['bad', 'Bad'], ['tilt', 'Tilt']];
const moodLabel = m => MOODS.find(([k]) => k === m)?.[1] || '';
const AUTO_START = '— Trades (auto-filled from your broker) —', AUTO_END = '— end of auto-fill —';
const PROMPTS = '\n\nPlan:\n\nExecution:\n\nLessons:\n';
const DISCIPLINE = ['', 'Broke my rules', 'Mostly off-plan', 'Mixed', 'Mostly on-plan', 'Followed every rule'];
/**
 * Put the day's trade data into a draft without overwriting what the trader wrote: title, symbol and
 * P&L are replaced only if empty or still the previous auto value; tags are merged; the notes' auto block
 * is replaced in place (or added on top), the rest of the notes is kept.
 */
export function applyAutofill(draft, a, prev = {}) {
  const d = { ...draft, tags: [...draft.tags] };
  if (!a?.trades) return d;
  const untouched = (value, auto) => value == null || value === '' || value === auto;
  if (untouched(d.title, prev.title)) d.title = a.title;
  if (untouched(d.symbol, prev.symbol)) d.symbol = a.symbol;
  if (untouched(d.pnl === '' ? null : d.pnl, prev.pnl) || String(d.pnl) === String(prev.pnl)) d.pnl = a.pnl;
  for (const t of a.tags) if (!d.tags.includes(t) && d.tags.length < 8) d.tags.push(t);
  const body = d.body || '', start = body.indexOf(AUTO_START), end = body.indexOf(AUTO_END);
  d.body = start >= 0 && end > start ? body.slice(0, start) + a.block + body.slice(end + AUTO_END.length)
    : body.trim() ? `${a.block}\n\n${body}` : a.block + PROMPTS;
  return d;
}
/** Take out what an earlier auto-fill put in (still unedited), keeping everything the trader wrote. */
export function clearAutofill(draft, prev) {
  const d = { ...draft, tags: [...draft.tags] };
  if (!prev) return d;
  if (d.title === prev.title) d.title = '';
  if (d.symbol === prev.symbol) d.symbol = '';
  if (d.pnl != null && d.pnl !== '' && String(d.pnl) === String(prev.pnl)) d.pnl = null;
  d.tags = d.tags.filter(t => !(prev.tags || []).includes(t));
  const body = d.body || '', start = body.indexOf(AUTO_START), end = body.indexOf(AUTO_END);
  if (start >= 0 && end > start) {
    const rest = (body.slice(0, start) + body.slice(end + AUTO_END.length)).replace(/^\s+/, '');
    d.body = rest === PROMPTS.trim() + '\n' || rest.trim() === PROMPTS.trim() ? '' : rest;
  }
  return d;
}
const blank = today => ({ id: null, day: today, title: '', body: '', mood: null, discipline: null, symbol: '', pnl: null, tags: [] });
const words = s => (String(s || '').trim().match(/\S+/g) || []).length;
/** The notes without the auto-filled trade list: what the trader wrote, for the table preview. */
const ownNotes = body => {
  const s = String(body || ''), a = s.indexOf(AUTO_START), b = s.indexOf(AUTO_END);
  const rest = a >= 0 && b > a ? s.slice(0, a) + s.slice(b + AUTO_END.length) : s;
  return rest.replace(/\b(Plan|Execution|Lessons):\s*(?=\n|$)/g, '').replace(/\s+/g, ' ').trim();
};

/** Entries matching the search box, mood and tag filters. */
export function filterEntries(entries, { q = '', mood = '', tag = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return entries.filter(e => (!mood || e.mood === mood) && (!tag || e.tags.includes(tag))
    && (!needle || [e.title, e.body, e.symbol, e.tags.join(' ')].some(x => String(x || '').toLowerCase().includes(needle))));
}
/** Table order: by date (newest first) or by P&L; entries without a P&L sort last either way. */
export function sortEntries(entries, { key = 'day', dir = 'desc' } = {}) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (key === 'pnl') {
      if (a.pnl == null || b.pnl == null) return (a.pnl == null) - (b.pnl == null);
      return sign * (a.pnl - b.pnl) || b.day.localeCompare(a.day);
    }
    return sign * a.day.localeCompare(b.day) || sign * (a.id - b.id);
  });
}

function topTags(entries, n = 12) {
  const count = new Map();
  for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}

function stats(s) {
  const tile = (label, value, sub, ic) => html`<div class="jr-stat"><span class="jr-stat-ico">${icon(ic)}</span><div><small>${label}</small><b>${value}</b>${sub ? html`<em>${sub}</em>` : ''}</div></div>`;
  return html`${tile('Entries', s.total, null, 'book')}${tile('This month', s.thisMonth, null, 'calendar')}
    ${tile('Streak', `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, s.streak ? 'Keep it going' : 'Write today', 'spark')}
    ${tile('Avg discipline', s.discipline == null ? '–' : `${s.discipline}/5`, null, 'shield')}`;
}

function tagBar(ctx) {
  const tags = topTags(ctx.data.entries);
  return tags.map(t => html`<button type="button" class="jr-chip tag" data-tag="${t}" aria-pressed="${String(ctx.ui.tag === t)}">#${t}</button>`);
}

export function tableView(ctx) {
  const { entries } = ctx.data, ui = ctx.ui;
  if (!entries.length) {
    return html`<div class="jr-empty"><div class="jr-orb" aria-hidden="true">${icon('book')}</div><h3>Your trading journal</h3>
      <p>Each entry fills itself from that day's broker trades. You add the plan, the execution and the lessons.</p>
      <button type="button" class="btn btn-primary" data-jr-new>${icon('plus')}Write today's entry</button><small class="muted">Shortcut: N · Ctrl + S saves</small></div>`;
  }
  const rows = sortEntries(filterEntries(entries, ui), ui.sort);
  if (!rows.length) return html`<div class="jr-empty small">${icon('search')}<b>Nothing matches</b><span>Try another word, or clear the filters.</span></div>`;
  const total = rows.reduce((s, e) => s + (e.pnl || 0), 0), withPnl = rows.filter(e => e.pnl != null);
  const arrow = key => ui.sort.key === key ? (ui.sort.dir === 'asc' ? '↑' : '↓') : '';
  const sortHead = (key, label, cls = '') => html`<th class="${cls}" aria-sort="${ui.sort.key === key ? (ui.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${key}">${label}<i>${arrow(key)}</i></button></th>`;
  return html`<div class="jr-table-wrap"><table class="jr-table">
    <thead><tr>${sortHead('day', 'Date')}<th>Entry</th><th>Mood</th><th>Discipline</th><th>Symbols</th>${sortHead('pnl', 'P&L', 'num')}<th>Tags</th><th aria-label="Open"></th></tr></thead>
    <tbody>${rows.map((e, i) => {
      const notes = ownNotes(e.body);
      return html`<tr class="jr-tr ${ui.selected === e.id ? 'active' : ''}" data-entry="${e.id}" tabindex="0" style="--i:${Math.min(i, 14)}" aria-label="Open ${e.title}">
        <td class="jr-td-date" data-label="Date"><b>${shortDay(e.day)}</b><small>${new Date(`${e.day}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</small></td>
        <td class="jr-td-entry" data-label="Entry"><b>${e.title}</b>${notes ? html`<small>${notes.slice(0, 120)}</small>` : ''}</td>
        <td data-label="Mood" class="${e.mood ? '' : 'is-empty'}">${e.mood ? html`<span class="jr-mood mood-${e.mood}"><i></i>${moodLabel(e.mood)}</span>` : html`<span class="dim">—</span>`}</td>
        <td data-label="Discipline" class="${e.discipline ? '' : 'is-empty'}">${e.discipline ? html`<span class="jr-dots" title="${DISCIPLINE[e.discipline]}">${[1, 2, 3, 4, 5].map(n => html`<i class="${n <= e.discipline ? 'on' : ''}"></i>`)}</span>` : html`<span class="dim">—</span>`}</td>
        <td class="jr-td-sym ${e.symbol ? '' : 'is-empty'}" data-label="Symbols">${e.symbol || html`<span class="dim">—</span>`}</td>
        <td class="num jr-pnl ${tone(e.pnl)}" data-label="P&L">${e.pnl != null ? inr(e.pnl, { sign: true }) : html`<span class="dim">—</span>`}</td>
        <td class="jr-td-tags ${e.tags.length ? '' : 'is-empty'}" data-label="Tags">${e.tags.slice(0, 4).map(t => html`<span>#${t}</span>`)}${e.tags.length > 4 ? html`<span class="more">+${e.tags.length - 4}</span>` : ''}</td>
        <td class="jr-td-open">${icon('arrow')}</td>
      </tr>`;
    })}</tbody>
    <tfoot><tr><td colspan="5">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${withPnl.filter(e => e.pnl > 0).length} green · ${withPnl.filter(e => e.pnl < 0).length} red</td>
      <td class="num jr-pnl ${tone(total)}">${withPnl.length ? inr(total, { sign: true }) : '—'}</td><td colspan="2"></td></tr></tfoot>
  </table></div>`;
}

function editorView(ctx) {
  const ui = ctx.ui, d = ui.draft;
  if (!d) return '';
  const existing = d.id != null;
  return html`<form class="jr-form" id="jr-form" autocomplete="off" novalidate>
    <div class="jr-form-head">
      <span class="jr-eyebrow" id="jr-sheet-title">${existing ? 'Edit entry' : 'New entry'}</span>
      ${ui.autoInfo ? html`<span class="jr-auto-badge">${icon('spark')}${ui.autoInfo}</span>` : ''}
      <button type="button" class="btn btn-ghost btn-sm jr-fill" data-jr-fill title="Fill title, symbols, P&amp;L, tags and a trade list from your broker trades on this date" ${ui.filling ? 'disabled' : ''}>${icon('refresh')}${ui.filling ? 'Filling…' : 'Fill from trades'}</button>
      <span class="jr-save-state ${ui.dirty ? 'dirty' : ''}" data-jr-state>${ui.dirty ? 'Unsaved changes' : existing ? `Saved ${ago(ui.savedAt || d.updatedAt)}` : 'Not saved yet'}</span>
      <button type="button" class="icon-btn jr-x" data-jr-close aria-label="Close">${icon('x')}</button>
    </div>
    <input class="jr-title" name="title" maxlength="120" placeholder="Give this day a title" value="${d.title}" aria-label="Title" required>
    <div class="jr-meta">
      <label class="jr-field"><small>Date</small><input class="input" type="date" name="day" value="${d.day}" max="${ctx.data.today}"></label>
      <label class="jr-field"><small>Symbol</small><input class="input" name="symbol" maxlength="40" placeholder="NIFTY 22500 CE" value="${d.symbol}"></label>
      <label class="jr-field"><small>P&amp;L (₹)</small><input class="input" name="pnl" inputmode="decimal" placeholder="e.g. 2450 or -800" value="${d.pnl ?? ''}"></label>
    </div>
    <div class="jr-pickers">
      <div class="jr-row"><small>Mood</small><div class="jr-moods" role="radiogroup" aria-label="Mood">
        ${MOODS.map(([k, l]) => html`<button type="button" role="radio" class="jr-mood-pick mood-${k}" data-pick-mood="${k}" aria-checked="${String(d.mood === k)}"><i></i>${l}</button>`)}
      </div></div>
      <div class="jr-row"><small>Discipline</small><div class="jr-discipline" role="radiogroup" aria-label="Discipline, 1 to 5">
        ${[1, 2, 3, 4, 5].map(n => html`<button type="button" role="radio" data-pick-discipline="${n}" aria-checked="${String(d.discipline === n)}" class="${d.discipline >= n ? 'lit' : ''}" aria-label="${n} of 5">${n}</button>`)}
        <span class="muted small">${d.discipline ? DISCIPLINE[d.discipline] : 'How well did you follow your plan?'}</span>
      </div></div>
    </div>
    <div class="jr-row"><small>Tags</small><div class="jr-tag-input">
      ${d.tags.map(t => html`<span class="jr-tag">#${t}<button type="button" data-remove-tag="${t}" aria-label="Remove tag ${t}">${icon('x')}</button></span>`)}
      ${d.tags.length < 8 ? html`<input id="jr-tag" placeholder="${d.tags.length ? 'Add tag' : 'orb, overtrading, patience… (Enter)'}" maxlength="24" aria-label="Add a tag">` : ''}
    </div></div>
    <textarea class="jr-body" name="body" maxlength="10000" placeholder="Plan · Execution · What went right · What to change tomorrow" aria-label="Notes">${d.body}</textarea>
    <div class="jr-foot">
      <span class="muted small" data-jr-words>${words(d.body)} words</span>
      <span class="grow"></span>
      ${existing ? html`<button type="button" class="btn btn-ghost jr-delete ${ui.armDelete ? 'armed' : ''}" data-jr-delete>${icon('trash')}${ui.armDelete ? 'Click again to delete' : 'Delete'}</button>` : ''}
      <button type="button" class="btn btn-ghost" data-jr-close>Cancel</button>
      <button type="submit" class="btn btn-primary" ${ui.saving ? 'disabled' : ''}>${icon('check')}${ui.saving ? 'Saving…' : existing ? 'Save changes' : 'Save entry'}</button>
    </div>
  </form>`;
}

function paintList(ctx) {
  const table = $('[data-jr-table]', ctx.el), tags = $('[data-jr-tagbar]', ctx.el);
  if (table) table.innerHTML = String(tableView(ctx));
  if (tags) { tags.innerHTML = String(html`${tagBar(ctx)}`); tags.hidden = !tags.children.length; }
}
/** Open, refresh or close the bottom sheet. */
function paintEditor(ctx, { focusTitle = false } = {}) {
  const wrap = $('[data-jr-sheet]', ctx.el), host = $('[data-jr-editor]', ctx.el);
  if (!wrap || !host) return;
  clearTimeout(ctx.ui.sheetTimer);
  if (!ctx.ui.draft) {
    wrap.classList.remove('open');
    document.documentElement.classList.remove('jr-lock');
    ctx.ui.sheetTimer = setTimeout(() => { if (!ctx.ui.draft) { wrap.hidden = true; host.innerHTML = ''; } }, 260);
    return;
  }
  host.innerHTML = String(editorView(ctx));
  host.scrollTop = 0;
  const opening = wrap.hidden || !wrap.classList.contains('open');
  wrap.hidden = false;
  document.documentElement.classList.add('jr-lock');
  if (opening) requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  else { host.classList.remove('jr-swap'); void host.offsetWidth; host.classList.add('jr-swap'); }
  autoGrow($('.jr-body', host));
  if (focusTitle) setTimeout(() => $('.jr-title', host)?.focus({ preventScroll: true }), 60);
}
function paintStats(ctx) { const host = $('[data-jr-stats]', ctx.el); if (host) host.innerHTML = String(stats(ctx.data.stats)); }
function autoGrow(area) { if (!area) return; area.style.height = 'auto'; area.style.height = `${Math.max(200, area.scrollHeight + 2)}px`; }
function markDirty(ctx) {
  if (ctx.ui.dirty) return;
  ctx.ui.dirty = true;
  const s = $('[data-jr-state]', ctx.el); if (s) { s.textContent = 'Unsaved changes'; s.classList.add('dirty'); }
}

export default {
  title: 'Journal',
  sub: 'Plan, execution and lessons from every trading day',
  layout: 'app',
  auth: true,

  async load(ctx) {
    Object.assign(ctx.ui, { q: ctx.ui.q || '', mood: ctx.ui.mood || '', tag: ctx.ui.tag || '', sort: ctx.ui.sort || { key: 'day', dir: 'desc' } });
    return get('/journal');
  },

  view(ctx) {
    const ui = ctx.ui;
    return html`<div class="jr">
      <div class="jr-stats" data-jr-stats>${stats(ctx.data.stats)}</div>
      <section class="panel jr-panel">
        <div class="jr-toolbar">
          <div class="jr-search">${icon('search')}<input class="input" id="jr-q" type="search" placeholder="Search notes, symbols, #tags" value="${ui.q}" autocomplete="off" aria-label="Search journal"></div>
          <div class="jr-filters" role="group" aria-label="Filter by mood">
            <button type="button" class="jr-chip" data-mood="" aria-pressed="${String(!ui.mood)}">All</button>
            ${MOODS.map(([k, l]) => html`<button type="button" class="jr-chip mood-${k}" data-mood="${k}" aria-pressed="${String(ui.mood === k)}"><i></i>${l}</button>`)}
          </div>
          <button type="button" class="btn btn-primary jr-new" data-jr-new>${icon('plus')}New entry</button>
        </div>
        <div class="jr-filters jr-tags" data-jr-tagbar role="group" aria-label="Filter by tag" ${topTags(ctx.data.entries).length ? '' : 'hidden'}>${tagBar(ctx)}</div>
        <div data-jr-table>${tableView(ctx)}</div>
      </section>
      <div class="jr-sheet-wrap" data-jr-sheet hidden>
        <div class="jr-scrim" data-jr-close></div>
        <section class="jr-sheet" role="dialog" aria-modal="true" aria-labelledby="jr-sheet-title">
          <button type="button" class="jr-grab" data-jr-close aria-label="Close"></button>
          <div class="jr-sheet-body" data-jr-editor></div>
        </section>
      </div>
    </div>`;
  },

  draw(ctx) { autoGrow($('.jr-body', ctx.el)); },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const open = (draft, opts) => {
      const target = draft === null ? 'close' : draft.id ?? 'new';
      if (ui.dirty && ui.confirmDiscard !== target) {
        ui.confirmDiscard = target;
        toast('You have unsaved changes. Click again to discard them.', 'warn');
        return;
      }
      Object.assign(ui, { draft: draft && { ...draft, tags: [...draft.tags] }, selected: draft?.id ?? null, dirty: false, armDelete: false, confirmDiscard: null, savedAt: null, autoInfo: '', lastAuto: null });
      for (const tr of $$('.jr-tr', el)) tr.classList.toggle('active', Number(tr.dataset.entry) === ui.selected);
      paintEditor(ctx, opts);
    };
    // Pull the date's broker trades into the draft (on New entry, on a date change, and from the Fill button).
    const fillFromTrades = async ({ quiet = false } = {}) => {
      const d = ui.draft; if (!d) return;
      if (ui.filling) { ui.refillQueued = true; return; }   // e.g. the date changed again while loading
      ui.filling = true; paintEditorKeep();
      try {
        const a = await get(`/journal/autofill?day=${encodeURIComponent(d.day)}`);
        if (ui.draft !== d) return;   // the trader moved on while this loaded
        if (!a.trades) { ui.autoInfo = 'No trades on this date'; if (!quiet) toast('No broker trades found on this date.', 'warn'); }
        else {
          ui.draft = applyAutofill(d, a, ui.lastAuto || {});
          ui.lastAuto = { title: a.title, symbol: a.symbol, pnl: a.pnl, tags: a.tags };
          ui.autoInfo = `Auto-filled from ${a.trades} trade${a.trades === 1 ? '' : 's'}`;
          if (d.id != null) markDirty(ctx);
        }
      } catch (e) { if (!quiet) toastError(e); }
      finally {
        ui.filling = false; paintEditorKeep();
        if (ui.refillQueued) { ui.refillQueued = false; fillFromTrades({ quiet: true }); }
      }
    };
    const newEntry = () => { open(blank(ctx.data.today), { focusTitle: true }); if (ui.draft && ui.draft.id == null) fillFromTrades({ quiet: true }); };
    on(el, 'click', '[data-jr-fill]', () => fillFromTrades(), signal);
    // Changing the date fills that day's trades in place of the previous day's auto-filled data.
    on(el, 'change', '#jr-form [name="day"]', (_, input) => {
      const d = ui.draft; if (!d || !input.value) return;
      d.day = input.value;
      ui.draft = clearAutofill(d, ui.lastAuto);
      ui.lastAuto = null; ui.autoInfo = '';
      markDirty(ctx);
      fillFromTrades({ quiet: true });
    }, signal);

    on(el, 'click', '[data-jr-new]', newEntry, signal);
    const openRow = tr => { const e = ctx.data.entries.find(x => x.id === Number(tr.dataset.entry)); if (e && ui.selected !== e.id) open(e); };
    on(el, 'click', '[data-entry]', (_, tr) => openRow(tr), signal);
    on(el, 'keydown', '[data-entry]', (e, tr) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(tr); } }, signal);
    on(el, 'click', '[data-jr-close]', () => open(null), signal);

    // Filters and sorting
    const repaintList = debounce(() => paintList(ctx), 120);
    on(el, 'input', '#jr-q', (_, input) => { ui.q = input.value; repaintList(); }, signal);
    on(el, 'click', '[data-mood]', (_, b) => {
      ui.mood = b.dataset.mood;
      for (const c of $$('[data-mood]', el)) c.setAttribute('aria-pressed', String(c.dataset.mood === ui.mood));
      paintList(ctx);
    }, signal);
    on(el, 'click', '[data-tag]', (_, b) => { ui.tag = ui.tag === b.dataset.tag ? '' : b.dataset.tag; paintList(ctx); }, signal);
    on(el, 'click', '[data-sort]', (_, b) => {
      const key = b.dataset.sort;
      ui.sort = { key, dir: ui.sort.key === key && ui.sort.dir === 'desc' ? 'asc' : 'desc' };
      paintList(ctx);
    }, signal);

    // Editor fields
    on(el, 'input', '#jr-form [name]', (_, input) => {
      const d = ui.draft; if (!d) return;
      d[input.name] = input.value;
      if (input.name === 'body') { autoGrow(input); const w = $('[data-jr-words]', el); if (w) w.textContent = `${words(input.value)} words`; }
      markDirty(ctx);
    }, signal);
    on(el, 'click', '[data-pick-mood]', (_, b) => { ui.draft.mood = ui.draft.mood === b.dataset.pickMood ? null : b.dataset.pickMood; markDirty(ctx); paintEditorKeep(); }, signal);
    on(el, 'click', '[data-pick-discipline]', (_, b) => { const n = Number(b.dataset.pickDiscipline); ui.draft.discipline = ui.draft.discipline === n ? null : n; markDirty(ctx); paintEditorKeep(); }, signal);
    on(el, 'click', '[data-remove-tag]', (_, b) => { ui.draft.tags = ui.draft.tags.filter(t => t !== b.dataset.removeTag); markDirty(ctx); paintEditorKeep('#jr-tag'); }, signal);
    on(el, 'keydown', '#jr-tag', (e, input) => {
      if (e.key === 'Backspace' && !input.value && ui.draft.tags.length) { ui.draft.tags.pop(); markDirty(ctx); paintEditorKeep('#jr-tag'); return; }
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const tag = input.value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 24);
      if (tag && !ui.draft.tags.includes(tag) && ui.draft.tags.length < 8) { ui.draft.tags.push(tag); markDirty(ctx); }
      paintEditorKeep('#jr-tag');
    }, signal);
    // Repaint the form in place (no animation), keeping the sheet's scroll and the given focus.
    function paintEditorKeep(focusSel) {
      const host = $('[data-jr-editor]', el);
      if (!host || !ui.draft) return;
      const scroll = host.scrollTop;
      host.classList.remove('jr-swap');
      host.innerHTML = String(editorView(ctx));
      autoGrow($('.jr-body', host)); host.scrollTop = scroll;
      if (focusSel) $(focusSel, host)?.focus({ preventScroll: true });
    }

    // Save (button or Ctrl/Cmd + S)
    const save = async () => {
      const d = ui.draft; if (!d || ui.saving) return;
      const pending = $('#jr-tag', el)?.value.trim();
      if (pending && d.tags.length < 8 && !d.tags.includes(pending.toLowerCase())) d.tags.push(pending.toLowerCase().replace(/^#/, '').replace(/\s+/g, '-'));
      if (!d.title.trim()) { toast('Give the entry a title.', 'warn'); $('.jr-title', el)?.focus(); return; }
      ui.saving = true; paintEditorKeep();
      const body = { day: d.day, title: d.title, body: d.body, mood: d.mood, discipline: d.discipline, symbol: d.symbol,
        pnl: d.pnl === '' || d.pnl == null ? null : d.pnl, tags: d.tags };
      try {
        const { entry } = d.id != null ? await put(`/journal/${d.id}`, body) : await post('/journal', body);
        ctx.data.entries = [...ctx.data.entries.filter(x => x.id !== entry.id), entry];
        ctx.data.stats = (await get('/journal')).stats;
        Object.assign(ui, { saving: false, dirty: false });
        toast(d.id != null ? 'Entry updated.' : 'Entry saved.', 'ok');
        paintStats(ctx);
        ui.selected = entry.id;
        open(null);   // close the sheet; the saved row is highlighted in the table
        ui.selected = entry.id; paintList(ctx);
      } catch (e) { ui.saving = false; paintEditorKeep(); toastError(e); }
    };
    on(el, 'submit', '#jr-form', e => { e.preventDefault(); save(); }, signal);

    // Delete: two clicks, the first arms it for 4 seconds.
    on(el, 'click', '[data-jr-delete]', async () => {
      const d = ui.draft; if (!d?.id) return;
      if (!ui.armDelete) {
        ui.armDelete = true; paintEditorKeep();
        clearTimeout(ui.armTimer); ui.armTimer = setTimeout(() => { if (ui.armDelete) { ui.armDelete = false; paintEditorKeep(); } }, 4000);
        return;
      }
      clearTimeout(ui.armTimer);
      try {
        await api(`/journal/${d.id}`, { method: 'DELETE' });
        ctx.data.entries = ctx.data.entries.filter(x => x.id !== d.id);
        ctx.data.stats = (await get('/journal')).stats;
        ui.dirty = false;
        open(null);
        paintStats(ctx); paintList(ctx);
        toast('Entry deleted.', 'ok');
      } catch (e) { toastError(e); }
    }, signal);

    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && ui.draft) { e.preventDefault(); save(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (!typing && !ui.draft && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newEntry(); }
      if (e.key === 'Escape' && ui.draft) open(null);
    }, { signal });
    window.addEventListener('beforeunload', e => { if (ui.dirty) { e.preventDefault(); e.returnValue = ''; } }, { signal });
    signal.addEventListener('abort', () => { clearTimeout(ui.armTimer); clearTimeout(ui.sheetTimer); document.documentElement.classList.remove('jr-lock'); }, { once: true });
  },
};
