import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketCache } from '../src/modules/scalper/cache.js';

test('warm chart requests reuse results, keep source time, and refresh at hard expiry', async () => {
  let now = 100, calls = 0;
  const cache = createMarketCache({ now:() => now }), account = {};
  const load = async () => ++calls;
  assert.equal((await cache(account,'chart:5:CE',30_000,load)).value,1);
  now += 29_999;
  const hit = await cache(account,'chart:5:CE',30_000,load);
  assert.equal(hit.cached,true); assert.equal(hit.asOf,100); assert.equal(calls,1);
  now++;
  assert.equal((await cache(account,'chart:5:CE',30_000,load)).value,2);
  await cache(account,'chart:5:CE',30_000,load,{fresh:true});
  assert.equal(calls,3);
});

test('simultaneous page/chart loads share one upstream request, including forced refresh', async () => {
  const cache = createMarketCache(), account = {};
  let finish, calls = 0;
  const load = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = cache(account,'chain',5000,load);
  const second = cache(account,'chain',5000,load,{fresh:true});
  await Promise.resolve();
  assert.equal(calls,1);
  finish({price:100});
  assert.deepEqual(await first,await second);
});

test('accounts, reconnects, instruments, days and intervals have separate cache entries', async () => {
  const cache = createMarketCache(), account = {}, other = {};
  let calls = 0;
  const load = async () => ++calls;
  for (const scope of [account,other]) for (const key of ['day1:CE:5','day1:PE:5','day1:CE:15','day2:CE:5']) await cache(scope,key,30000,load);
  assert.equal(calls,8);
  await cache({},'day1:CE:5',30000,load);
  assert.equal(calls,9);
});

test('failures are retried and cannot fall back to expired or invalid market data', async () => {
  let now = 0, calls = 0;
  const cache = createMarketCache({now:()=>now}), account = {};
  await cache(account,'chart',10,async()=>123);
  now = 11;
  const fail = async () => { calls++; throw new Error('Token expired'); };
  await assert.rejects(cache(account,'chart',10,fail),/Token expired/);
  await assert.rejects(cache(account,'chart',10,fail),/Token expired/);
  assert.equal(calls,2);
  assert.equal((await cache(account,'chart',10,async()=>456)).value,456);
});

test('cache bounds chart memory while retaining recently used entries', async () => {
  const cache = createMarketCache({maxEntries:2}), account = {};
  let calls = 0;
  const load = async () => ++calls;
  await cache(account,'a',30000,load); await cache(account,'b',30000,load);
  await cache(account,'a',30000,load); await cache(account,'c',30000,load);
  assert.equal((await cache(account,'a',30000,load)).cached,true);
  assert.equal((await cache(account,'b',30000,load)).cached,false);
  assert.equal(calls,4);
});
