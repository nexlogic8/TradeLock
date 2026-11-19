// Manual option entries at market go to Dhan as Super Orders: stop-loss at the Option SL room, target at 1:2.
process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createUser } = await import('../src/modules/auth/service.js');
const { getRules, saveRules } = await import('../src/modules/rules/service.js');
const { superLevels } = await import('../src/modules/orders/routes.js');

const dhan = { placeSuperOrder() {} };
const order = (side, extra = {}) => ({ side, type: 'MARKET', qty: 65, exchangeSegment: 'NSE_FNO', ...extra });

test('SL at the Option SL room, TP at twice that distance (1:2), on the right side for a buy and a sell', () => {
  const uid = createUser({ email: 'super@orders.test', password: null, name: 'S' });
  saveRules(uid, { ...getRules(uid).manual, optionSl: { on: true, value: 20 } });
  const acct = { id: 1, broker: 'dhan', paper_mode: 0 };
  assert.deepEqual(superLevels(uid, acct, dhan, order('BUY'), 100), { sl: 80, tp: 140 });
  assert.deepEqual(superLevels(uid, acct, dhan, order('SELL'), 100), { sl: 120, tp: 60 });
  assert.deepEqual(superLevels(uid, acct, dhan, order('BUY'), 11.05), { sl: 8.85, tp: 15.45 }, 'rounded to the 0.05 tick');
});

test('plain orders: not Dhan, paper, a limit, not an option, near a freeze limit, Option SL room off, no price, no target room', () => {
  const uid = createUser({ email: 'plain@orders.test', password: null, name: 'P' });
  const acct = { id: 2, broker: 'dhan', paper_mode: 0 };
  assert.equal(superLevels(uid, { ...acct, broker: 'mock' }, dhan, order('BUY'), 100), null);
  assert.equal(superLevels(uid, { ...acct, paper_mode: 1 }, dhan, order('BUY'), 100), null);
  assert.equal(superLevels(uid, acct, {}, order('BUY'), 100), null, 'an adapter without super orders (StoxKart routing)');
  assert.equal(superLevels(uid, acct, dhan, order('BUY', { type: 'LIMIT' }), 100), null);
  assert.equal(superLevels(uid, acct, dhan, order('BUY', { exchangeSegment: 'MCX_COMM' }), 100), null);
  assert.equal(superLevels(uid, acct, dhan, order('BUY', { qty: 1800 }), 100), null);
  assert.equal(superLevels(uid, acct, dhan, order('BUY'), 0), null);
  saveRules(uid, { ...getRules(uid).manual, optionSl: { on: true, value: 60 } });
  assert.equal(superLevels(uid, acct, dhan, order('SELL'), 100), null, 'a sell with a 60% stop has no room for a 1:2 target');
  saveRules(uid, { ...getRules(uid).manual, optionSl: { on: false, value: 20 } });
  assert.equal(superLevels(uid, acct, dhan, order('BUY'), 100), null);
});
