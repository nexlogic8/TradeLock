// Token keeper microservice: renews Dhan access tokens at 06:00 and 18:00 IST.
//   node server/src/workers/token-renewer.js          scheduled (runs forever)
//   node server/src/workers/token-renewer.js --once   one pass now, then exit
// Shares the database with the app (SQLite WAL allows a second process). The app notices a renewed
// token on its next account refresh (a few seconds) and switches to it without a restart.
// Health (heartbeat, last run, next run) is written to service_status for the admin console, and a
// "Run now" from the console is picked up within HEARTBEAT_MS.
import { renewDueTokens, msUntilNextRun, RUN_TIMES_IST, SAFETY_EVERY_MS, SAFETY_WITHIN_MS } from '../modules/broker/tokenkeeper.js';
import { report, getStatus } from '../lib/servicestatus.js';
import { db } from '../db/index.js';

const NAME = 'tokenkeeper';
const HEARTBEAT_MS = 30e3;
let running = false;

async function runOnce(reason, opts = {}) {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const r = await renewDueTokens(opts);
    if (opts.within && !r.renewed && !r.expired && !r.failed) return;   // quiet safety pass: nothing was due
    report(NAME, { last_run_at: started, last_run_ms: Date.now() - started, last_result: { ...r, reason }, last_error: null });
    console.log(`[tokenkeeper] ${reason}: checked ${r.checked}, renewed ${r.renewed}, expired ${r.expired}, failed ${r.failed}, not due ${r.skipped} (${Date.now() - started} ms)`);
  } catch (e) {
    report(NAME, { last_run_at: started, last_run_ms: Date.now() - started, last_error: String(e.message).slice(0, 300) });
    console.error('[tokenkeeper] run failed:', e);
  } finally {
    running = false;
  }
}

if (process.argv.includes('--once')) {
  await runOnce('manual run');
  db.close();
  process.exit(0);
}

let timer;
function schedule() {
  const wait = msUntilNextRun();
  report(NAME, { next_run_at: Date.now() + wait });
  console.log(`[tokenkeeper] next run at ${new Date(Date.now() + wait).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  timer = setTimeout(async () => { await runOnce('scheduled run'); schedule(); }, wait);
}

report(NAME, { started_at: Date.now(), heartbeat_at: Date.now(), run_requested: 0 });
console.log(`[tokenkeeper] started; runs daily at ${RUN_TIMES_IST.join(' and ')} IST`);
// A check at start-up too, so a restart never skips a due renewal (tokens not due are left alone).
await runOnce('start-up check');
schedule();

// Hourly safety pass: renews only tokens that would expire within SAFETY_WITHIN_MS.
const safety = setInterval(() => runOnce('safety check', { within: SAFETY_WITHIN_MS }), SAFETY_EVERY_MS);

// Heartbeat + "Run now" requests from the admin console.
const beat = setInterval(async () => {
  report(NAME, { heartbeat_at: Date.now() });
  if (getStatus(NAME)?.run_requested) {
    report(NAME, { run_requested: 0 });
    await runOnce('run requested from admin');
  }
}, HEARTBEAT_MS);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearTimeout(timer); clearInterval(beat); clearInterval(safety); db.close(); process.exit(0); });
