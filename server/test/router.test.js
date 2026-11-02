import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('navigation cancels old loads and prevents old pages repainting the current page', async () => {
  const page = { innerHTML: '' };
  const subscribers = new Set();
  const contexts = {};
  let finishLoad;
  let slow = false;
  const fixture = {
    store: { get: () => ({ user: { admin: true } }), on(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } },
    mountShell: () => ({ page, activate(name) { fixture.selected = name; } }),
    pages: Object.fromEntries(['algo', 'scalper'].map(name => [name, async () => ({ default: {
      title: name, layout: 'app', live: ['dash'],
      load(ctx) { contexts[name] = ctx; return slow && name === 'algo' ? new Promise(resolve => { finishLoad = resolve; }) : {}; },
      view: () => name,
    } })])),
  };
  globalThis.__routerTest = fixture;
  globalThis.document = { getElementById: () => page, body: { dataset: {} }, addEventListener() {} };
  globalThis.window = { addEventListener() {}, scrollTo() {} };
  globalThis.location = { pathname: '/algo' };
  globalThis.history = { replaceState(_state, _title, path) { location.pathname = path; } };
  let source = readFileSync(new URL('../../web/js/core/router.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?\n/gm, '')
    .replace(/const PAGES = \{[\s\S]*?\n\};/, 'const PAGES = globalThis.__routerTest.pages;');
  source = 'const { store, mountShell } = globalThis.__routerTest; const debounce = fn => fn; const errorView = String; const unmountShell = () => {};\n' + source;
  const { show } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  try {
    await show('algo');
    const old = contexts.algo;
    await show('scalper');
    old.paint();
    for (const fn of subscribers) fn({ dash: {} });
    assert.equal(old.signal.aborted, true);
    assert.equal(page.innerHTML, '<div class="">scalper</div>');
    slow = true;
    const pending = show('algo');
    await new Promise(resolve => setImmediate(resolve));
    await show('scalper');
    finishLoad({});
    await pending;
    assert.equal(fixture.selected, 'scalper');
    assert.match(page.innerHTML, />scalper<\/div>/);
    assert.equal(contexts.algo.signal.aborted, true);
    assert.equal(subscribers.size, 1);
  } finally {
    for (const key of ['__routerTest', 'document', 'window', 'location', 'history']) delete globalThis[key];
  }
});
