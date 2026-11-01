import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeNiftyExpiries, resolveNiftyExpiry } from '../src/modules/scalper/expiry.js';

test('active expiries omit past dates and sort the next contracts',()=>{
  const clock={day:'2026-10-14',minutes:8*60+30,weekday:'Wed'};
  const active=activeNiftyExpiries(['2026-10-20','2026-10-13','2026-10-15','invalid','2026-10-20'],clock);
  assert.deepEqual(active,['2026-10-15','2026-10-20']);
  assert.equal(resolveNiftyExpiry(undefined,active,clock),'2026-10-15','Wednesday: the current expiry');
  assert.equal(resolveNiftyExpiry(undefined,['2026-10-15'],clock),'2026-10-15','a single listed expiry is used as is');
  assert.equal(resolveNiftyExpiry('2026-10-13',active,clock),'2026-10-15');
});

test('today expiry remains available before close and rolls forward after expiry',()=>{
  const expiries=['2026-10-14','2026-10-20'];
  const beforeClose={day:'2026-10-14',minutes:15*60+29,weekday:'Wed'};
  assert.deepEqual(activeNiftyExpiries(expiries,beforeClose),expiries);
  assert.equal(resolveNiftyExpiry('2026-10-14',expiries,beforeClose),'2026-10-14');
  const afterClose={...beforeClose,minutes:15*60+30};
  const active=activeNiftyExpiries(expiries,afterClose);
  assert.deepEqual(active,['2026-10-20']);
  assert.equal(resolveNiftyExpiry('2026-10-14',active,afterClose),'2026-10-20');
});

test('today expiry is not offered on weekends and unknown future expiry is rejected',()=>{
  const clock={day:'2026-10-17',minutes:10*60,weekday:'Sat'};
  const active=activeNiftyExpiries(['2026-10-17','2026-10-20'],clock);
  assert.deepEqual(active,['2026-10-20']);
  assert.equal(resolveNiftyExpiry('2026-10-21',active,clock),null);
});

test('default expiry: 2nd on Monday-Tuesday and weekends, current on Wednesday-Friday',()=>{
  const expiries=['2026-10-20','2026-10-27','2026-11-03'];
  const at=weekday=>resolveNiftyExpiry(undefined,expiries,{day:'2026-10-19',minutes:600,weekday});
  assert.deepEqual(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(at),
    ['2026-10-27','2026-10-27','2026-10-20','2026-10-20','2026-10-20','2026-10-27','2026-10-27']);
  // Tuesday after the close: that day's expiry is gone from the list, so the nearest remaining one is used.
  assert.equal(resolveNiftyExpiry(undefined,['2026-10-27','2026-11-03'],{day:'2026-10-20',minutes:15*60+45,weekday:'Tue'}),'2026-10-27');
});
