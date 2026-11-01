process.env.DB_PATH = ':memory:';
process.env.MONITOR = '0';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { nextCapital } = await import('../src/modules/risk/monitor.js');

const snap = (available, positions = []) => ({ funds: { available, used: 0, opening: available }, positions });
const day = over => ({ capital: 299999.66, entries: 0, realized: 0, ...over });

test('before the first trade, capital follows the broker down (yesterday’s balance read before the roll-over)', () => {
  assert.equal(nextCapital(1, day(), snap(281704.75), 0), 281704.75);
});

test('after a trade, losses never shrink capital; an unchanged reading keeps it', () => {
  assert.equal(nextCapital(2, day({ capital: 281704.75, entries: 1 }), snap(270000), -11704.75 + 11704.75), 281704.75);
  assert.equal(nextCapital(3, day({ capital: 281704.75 }), snap(281704.75, [{ qty: 50 }]), 0), 281704.75, 'open position: kept');
  assert.equal(nextCapital(4, day({ capital: 281704.75, entries: 2 }), snap(260000), 0), 281704.75);
});

test('first reading of the day is taken as is', () => {
  assert.equal(nextCapital(5, day({ capital: null }), snap(150000), 0), 150000);
});
