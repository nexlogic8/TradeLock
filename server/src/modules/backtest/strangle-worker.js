// Worker thread for the "CE + PE at a target price" backtest (see strangle.js): reads history.db and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import { strangleBacktest } from './strangle.js';

try { parentPort.postMessage({ result: strangleBacktest(workerData) }); }
catch (e) { parentPort.postMessage({ error: e.message, code: e.code }); }
