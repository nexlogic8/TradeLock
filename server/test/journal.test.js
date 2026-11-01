process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const { journalRoutes, normalizeEntry } = await import('../src/modules/journal/routes.js');
const { filterEntries } = await import('../../web/js/pages/journal.js');

const routes = new Map();
const add = method => (path, fn) => routes.set(`${method} ${path}`, fn);
journalRoutes({ get:add('GET'), post:add('POST'), put:add('PUT'), delete:add('DELETE') });
const call = (method, path, user, { body = {}, params = {} } = {}) => routes.get(`${method} ${path}`)({ user:{ id:user }, body, params, query:{} });

test('journal CRUD for the owner, with stats', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-16T10:00:00+05:30'));
  const uid = createUser({ email:'journal@test.local', password:null, name:'J' });
  const { entry } = call('POST', '/api/journal', uid, { body:{ day:'2026-10-16', title:'  ORB long worked ', body:'Waited for the confirmation candle.', mood:'great', discipline:5, symbol:'nifty 22500 ce', pnl:'2,450.5', tags:['ORB', '#patience', 'orb'] } });
  assert.deepEqual([entry.title, entry.mood, entry.discipline, entry.symbol, entry.pnl, entry.tags], ['ORB long worked', 'great', 5, 'NIFTY 22500 CE', 2450.5, ['orb', 'patience']]);
  call('POST', '/api/journal', uid, { body:{ day:'2026-10-15', title:'Overtraded', mood:'tilt', discipline:2, pnl:-800 } });

  let list = call('GET', '/api/journal', uid);
  assert.deepEqual(list.entries.map(e => e.title), ['ORB long worked', 'Overtraded'], 'newest day first');
  assert.deepEqual(list.stats, { total:2, thisMonth:2, streak:2, discipline:3.5 });

  const { entry: updated } = call('PUT', '/api/journal/:id', uid, { params:{ id:String(entry.id) }, body:{ ...entry, title:'ORB long, held to target', mood:null, pnl:'' } });
  assert.deepEqual([updated.title, updated.mood, updated.pnl], ['ORB long, held to target', null, null]);

  assert.deepEqual(call('DELETE', '/api/journal/:id', uid, { params:{ id:String(entry.id) } }), { ok:true, id:entry.id });
  list = call('GET', '/api/journal', uid);
  assert.deepEqual(list.entries.map(e => e.title), ['Overtraded']);
});

test('another user cannot read, change or delete an entry', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-16T10:00:00+05:30'));
  const owner = createUser({ email:'owner@journal.local', password:null, name:'O' });
  const other = createUser({ email:'other@journal.local', password:null, name:'X' });
  const { entry } = call('POST', '/api/journal', owner, { body:{ title:'Private' } });
  assert.equal(call('GET', '/api/journal', other).entries.length, 0);
  assert.throws(() => call('PUT', '/api/journal/:id', other, { params:{ id:String(entry.id) }, body:{ title:'Hacked' } }), /not found/i);
  assert.throws(() => call('DELETE', '/api/journal/:id', other, { params:{ id:String(entry.id) } }), /not found/i);
  assert.equal(call('GET', '/api/journal', owner).entries[0].title, 'Private');
});

test('validation: title required, future dates, moods, discipline, tags', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-16T10:00:00+05:30'));
  assert.throws(() => normalizeEntry({ title:'  ' }), /Title/);
  assert.throws(() => normalizeEntry({ title:'x', day:'2026-10-17' }), /today or earlier/);
  assert.throws(() => normalizeEntry({ title:'x', day:'2026-02-30' }), /valid date/);
  assert.throws(() => normalizeEntry({ title:'x', mood:'happy' }), /Mood/);
  assert.throws(() => normalizeEntry({ title:'x', discipline:6 }), /Discipline/);
  assert.throws(() => normalizeEntry({ title:'x', tags:Array.from({ length:9 }, (_, i) => `t${i}`) }), /8 tags/);
  assert.equal(normalizeEntry({ title:'x' }).day, '2026-10-16', 'defaults to today (IST)');
});

test('page filter: search text, mood and tag', () => {
  const entries = [
    { title:'ORB long', body:'patience paid', symbol:'NIFTY', mood:'great', tags:['orb'] },
    { title:'Revenge trade', body:'', symbol:'SENSEX', mood:'tilt', tags:['overtrading'] },
  ];
  assert.deepEqual(filterEntries(entries, { q:'PATIENCE' }).map(e => e.title), ['ORB long']);
  assert.deepEqual(filterEntries(entries, { q:'sensex' }).map(e => e.title), ['Revenge trade']);
  assert.deepEqual(filterEntries(entries, { mood:'tilt' }).map(e => e.title), ['Revenge trade']);
  assert.deepEqual(filterEntries(entries, { tag:'orb' }).map(e => e.title), ['ORB long']);
});

test('auto-fill: round trips, trade list, P&L, tags and rule events from the day\'s broker data', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-16T15:40:00+05:30'));
  const { stmt } = await import('../src/db/index.js');
  const { patchDay } = await import('../src/modules/risk/service.js');
  const { autofill } = await import('../src/modules/journal/routes.js');
  const uid = createUser({ email:'autofill@journal.local', password:null, name:'A' });
  const ts = hhmm => Date.parse(`2026-10-16T${hhmm}:00+05:30`);
  const fill = (id, symbol, side, qty, price, at) => stmt(`INSERT INTO trades (user_id, day, ts, kind, ext_id, symbol, side, qty, price, status) VALUES (?, '2026-10-16', ?, 'exec', ?, ?, ?, ?, ?, 'COMPLETE')`).run(uid, ts(at), id, symbol, side, qty, price);
  fill('a1', 'NIFTY-Oct2026-22950-PE', 'BUY', 65, 144.5, '09:31');
  fill('a2', 'NIFTY-Oct2026-22950-PE', 'BUY', 65, 140.5, '09:33');      // averaged in
  fill('a3', 'NIFTY-Oct2026-22950-PE', 'SELL', 130, 137.65, '09:44');
  fill('b1', 'SENSEX-Oct2026-74100-PE', 'BUY', 80, 596.65, '10:02');
  fill('b2', 'SENSEX-Oct2026-74100-PE', 'SELL', 80, 620, '10:20');
  fill('c1', 'BANKNIFTY-Oct2026-55600-PE', 'BUY', 30, 500, '11:00');    // still open
  stmt(`INSERT INTO trades (user_id, day, ts, kind, ext_id, symbol, side, status, note) VALUES (?, '2026-10-16', ?, 'event', 'e1', 'Trade cap reached', 'LIMIT', 'LOGGED', '3 of 3 entries used.')`).run(uid, ts('10:21'));
  patchDay(uid, '2026-10-16', { realized: 1077.5, unrealized: -150, fired: ['maxTrades.warn', 'maxTrades.breach'] });

  const a = autofill(uid, '2026-10-16');
  assert.equal(a.trades, 3);
  assert.equal(a.title, '3 trades · 1W 1L · +₹928');
  assert.equal(a.symbol, 'NIFTY 22950 PE, SENSEX 74100 PE +1', 'whole symbols only');
  assert.equal(a.pnl, 927.5);
  assert.deepEqual(a.tags, ['nifty', 'sensex', 'banknifty', 'green-day', 'trade-cap']);
  assert.match(a.block, /1\. 09:31 → 09:44  NIFTY 22950 PE  BUY 130 @ 142\.50 → 137\.65  −₹630\.50/);
  assert.match(a.block, /2\. 10:02 → 10:20  SENSEX 74100 PE  BUY 80 @ 596\.65 → 620\.00  \+₹1,868\.00/);
  assert.match(a.block, /3\. 11:00 → open   BANKNIFTY 55600 PE  BUY 30 @ 500\.00  \(still open\)/);
  assert.match(a.block, /• Trade cap reached — 3 of 3 entries used\./);
  assert.equal(autofill(uid, '2026-10-15').trades, 0, 'a day with no trades fills nothing');
});

test('auto-fill on the page keeps what the trader wrote', async () => {
  const { applyAutofill } = await import('../../web/js/pages/journal.js');
  const a = { trades:2, title:'2 trades · 1W 1L · +₹500', symbol:'NIFTY 22950 PE', pnl:500, tags:['nifty', 'green-day'],
    block:'— Trades (auto-filled from your broker) —\n1. trade\n— end of auto-fill —' };
  const fresh = applyAutofill({ title:'', symbol:'', pnl:null, tags:[], body:'' }, a);
  assert.deepEqual([fresh.title, fresh.symbol, fresh.pnl, fresh.tags], [a.title, a.symbol, 500, ['nifty', 'green-day']]);
  assert.match(fresh.body, /^— Trades[\s\S]*end of auto-fill —\n\nPlan:\n\nExecution:\n\nLessons:\n$/);
  // The trader renamed it and wrote notes; a refill updates only the auto parts.
  const edited = { ...fresh, title:'Patience paid off', tags:[...fresh.tags, 'orb'], body:fresh.body.replace('Lessons:\n', 'Lessons:\nWait for confirmation.\n') };
  const refill = applyAutofill(edited, { ...a, title:'3 trades', pnl:900, block:'— Trades (auto-filled from your broker) —\n1. trade\n2. trade\n— end of auto-fill —' }, { title:a.title, symbol:a.symbol, pnl:500 });
  assert.equal(refill.title, 'Patience paid off');
  assert.equal(refill.pnl, 900, 'P&L still the auto value, so it updates');
  assert.deepEqual(refill.tags, ['nifty', 'green-day', 'orb']);
  assert.match(refill.body, /2\. trade[\s\S]*Wait for confirmation\./);
});

test('changing the date swaps the auto-filled day for the new one and keeps the trader\'s own text', async () => {
  const { applyAutofill, clearAutofill } = await import('../../web/js/pages/journal.js');
  const B = (lines) => `— Trades (auto-filled from your broker) —\n${lines}\n— end of auto-fill —`;
  const oct16 = { trades:3, title:'3 trades · 0W 3L · −₹7,198', symbol:'BANKNIFTY 55600 PE', pnl:-7197.75, tags:['banknifty', 'red-day', 'trade-cap'], block:B('16 Oct trades') };
  const oct14 = { trades:2, title:'2 trades · 0W 2L · −₹5,051', symbol:'NIFTY 22900 CE', pnl:-5050.5, tags:['nifty', 'red-day', 'loss-streak'], block:B('14 Oct trades') };
  let d = applyAutofill({ title:'', symbol:'', pnl:null, tags:[], body:'' }, oct16);
  d = { ...d, tags:[...d.tags, 'revenge'], body:d.body.replace('Lessons:\n', 'Lessons:\nStop after two losses.\n') };
  const cleared = clearAutofill(d, oct16);
  assert.deepEqual([cleared.title, cleared.symbol, cleared.pnl, cleared.tags], ['', '', null, ['revenge']]);
  assert.doesNotMatch(cleared.body, /16 Oct/);
  const swapped = applyAutofill(cleared, oct14);
  assert.deepEqual([swapped.title, swapped.symbol, swapped.pnl], [oct14.title, oct14.symbol, -5050.5]);
  assert.deepEqual(swapped.tags, ['revenge', 'nifty', 'red-day', 'loss-streak']);
  assert.match(swapped.body, /14 Oct trades[\s\S]*Stop after two losses\./);
  // A day with nothing auto-filled before: only empty prompts go, so the next fill starts clean.
  const blankPrompts = clearAutofill(applyAutofill({ title:'', symbol:'', pnl:null, tags:[], body:'' }, oct16), oct16);
  assert.equal(blankPrompts.body, '');
});

test('journal table: sort by date or P&L, own-notes preview, totals', async () => {
  const { sortEntries, tableView } = await import('../../web/js/pages/journal.js');
  const entries = [
    { id:1, day:'2026-10-14', title:'Loss streak', body:'— Trades (auto-filled from your broker) —\n1. x\n— end of auto-fill —\n\nPlan:\n\nExecution:\n\nLessons:\nStop after two losses.', mood:'tilt', discipline:2, symbol:'NIFTY 22900 PE', pnl:-5050.5, tags:['nifty', 'red-day'] },
    { id:2, day:'2026-10-16', title:'Three red', body:'', mood:null, discipline:null, symbol:'', pnl:-7197.75, tags:[] },
    { id:3, day:'2026-10-15', title:'Big green', body:'', mood:'great', discipline:5, symbol:'NIFTY 22650 CE', pnl:147757.75, tags:['green-day'] },
    { id:4, day:'2026-10-13', title:'Notes only', body:'', mood:null, discipline:null, symbol:'', pnl:null, tags:[] },
  ];
  assert.deepEqual(sortEntries(entries).map(e => e.id), [2, 3, 1, 4], 'newest first');
  assert.deepEqual(sortEntries(entries, { key:'pnl', dir:'desc' }).map(e => e.id), [3, 1, 2, 4], 'best P&L first, blanks last');
  assert.deepEqual(sortEntries(entries, { key:'pnl', dir:'asc' }).map(e => e.id), [2, 1, 3, 4]);
  const html = String(tableView({ data:{ entries }, ui:{ q:'', mood:'', tag:'', sort:{ key:'day', dir:'desc' } } }));
  assert.equal((html.match(/class="jr-tr /g) || []).length, 4);
  assert.match(html, /<small>Stop after two losses\.<\/small>/, 'preview shows what the trader wrote, not the trade list');
  assert.match(html, /4 entries · 1 green · 2 red/);
  assert.match(html, /\+₹1,35,510/, 'filtered total P&L');
  assert.match(html, /aria-sort="descending"><button type="button" data-sort="day">Date<i>↓<\/i>/);
});
