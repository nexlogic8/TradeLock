const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { signalBudget } = await import('../src/modules/scalper/signal-risk.js');

test('trade cap off: Power Scalper still sizes trades from the trades-per-day number', () => {
  const rules = { maxLoss:{ on:true, mode:'percent', value:5 }, maxTrades:{ on:false, value:3 } };
  const budget = signalBudget(rules, 204713, 0);
  assert.ok(budget, 'sizing does not need the cap switched on');
  assert.equal(budget.trades, 3);
  assert.equal(budget.perTrade, 3411.88);
  assert.equal(signalBudget({ ...rules, maxLoss:{ ...rules.maxLoss, on:false } }, 204713, 0), null, 'the daily stop-loss is still required');
});
