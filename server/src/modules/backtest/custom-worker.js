// Worker thread for the "My strategies" backtest (see custom.js): reads history.db and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import { customBacktest } from './custom.js';

try { parentPort.postMessage({ result: customBacktest(workerData) }); }
catch (e) { parentPort.postMessage({ error: e.message, code: e.code }); }
