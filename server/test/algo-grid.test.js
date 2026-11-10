// Algo Trading grid: strategies switched on per index; read from the older single switches until saved; the older
// columns kept in step; each index's own view for the scanner; the risk gate lets Algo entries run side by side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { algoGrid, indexView, legacyColumns, slotOn, strategyIndices } from '../src/modules/scalper/algo-grid.js';
import { checkOrder } from '../src/modules/risk/gate.js';

const legacy = { orb_on: 0, cross_on: 0, ema915_on: 1, gap_on: 1, strangle_on: 1, algo_underlying: 'NIFTY,SENSEX', strangle_cfg: JSON.stringify({ target: 4, capital: 50000 }) };

test('before the grid is saved it is read from the older switches; CE + PE was NIFTY only', () => {
  const g = algoGrid(legacy);
  assert.deepEqual(strategyIndices(legacy, 'gap'), ['NIFTY', 'SENSEX']);
  assert.deepEqual(strategyIndices(legacy, 'ema915'), ['NIFTY', 'SENSEX']);
  assert.deepEqual(strategyIndices(legacy, 'orb'), []);
  assert.deepEqual(strategyIndices(legacy, 'strangle'), ['NIFTY']);
  assert.deepEqual(g.strangle.NIFTY.cfg, { target: 4, capital: 50000 });
  // ORB and EMA 5/9 were on unless switched off (column default 1).
  assert.deepEqual(strategyIndices({ algo_underlying: 'NIFTY' }, 'orb'), ['NIFTY']);
});

test('a saved grid: each strategy on its own indices; the scanner sees one index at a time', () => {
  const grid = { strangle: { NIFTY: { on: true, cfg: { target: 4 } }, SENSEX: { on: true, cfg: { target: 100 } } }, gap: { BANKNIFTY: { on: true } } };
  const acct = { ...legacy, algo_grid: JSON.stringify(grid) };
  assert.deepEqual(strategyIndices(acct, 'strangle'), ['NIFTY', 'SENSEX']);
  assert.deepEqual(strategyIndices(acct, 'gap'), ['BANKNIFTY']);
  assert.equal(slotOn(acct, 'ema915', 'NIFTY'), false, 'the older switch no longer counts once the grid is saved');
  const sensex = indexView(acct, 'SENSEX'), bank = indexView(acct, 'BANKNIFTY');
  assert.deepEqual([sensex.strangle_on, sensex.gap_on, sensex.orb_on], [1, 0, 0]);
  assert.deepEqual([bank.strangle_on, bank.gap_on, bank.cross_on], [0, 1, 0]);
});

test('the older columns follow the grid: on for any index; the indices anything is on for', () => {
  const cols = legacyColumns(algoGrid({ algo_grid: JSON.stringify({ strangle: { SENSEX: { on: true }, NIFTY: { on: false, cfg: { target: 5 } } }, orb: { BANKNIFTY: { on: true } } }) }));
  assert.deepEqual(cols, { orb_on: 1, cross_on: 0, ema915_on: 0, gap_on: 0, strangle_on: 1, algo_underlying: 'BANKNIFTY,SENSEX', strangle_cfg: JSON.stringify({ target: 5 }) });
  assert.equal(legacyColumns(algoGrid({ algo_grid: '{}' })).algo_underlying, 'NIFTY', 'nothing on: NIFTY stays the watched index');
});

test('risk gate: an Algo entry is not blocked by other open positions or pending orders; a manual order still is', () => {
  const rules = { cutoff: { on: false }, maxTrades: { on: false }, maxLoss: { on: false }, capital: { on: false } };
  const s = { rules, positions: [{ symbol: 'SENSEX X', qty: 20 }], orders: [{ id: 1 }], entries: 1, pnl: 0, minutes: 600, capital: 100000, subscriptionActive: true };
  const order = { symbol: 'NIFTY Y', side: 'BUY', qty: 65, price: 10 };
  assert.equal(checkOrder(order, s).code, 'TRADE_RUNNING');
  assert.deepEqual(checkOrder(order, { ...s, concurrent: true }), { ok: true, reducing: false });
  assert.equal(checkOrder(order, { ...s, concurrent: true, entryInFlight: true }).code, 'ORDER_IN_FLIGHT', 'one order is placed at a time');
});
