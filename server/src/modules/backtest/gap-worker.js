// Worker thread for the Gap open 09:15 backtest (see gap.js): reads history.db and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import { gapBacktest } from './gap.js';

try { parentPort.postMessage({ result: gapBacktest(workerData) }); }
catch (e) { parentPort.postMessage({ error: e.message, code: e.code }); }
