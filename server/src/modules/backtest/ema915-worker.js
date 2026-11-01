// Worker thread for the EMA 9/15 5m backtest (see ema915.js): reads history.db and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import { ema915Backtest } from './ema915.js';

try { parentPort.postMessage({ result: ema915Backtest(workerData) }); }
catch (e) { parentPort.postMessage({ error: e.message, code: e.code }); }
