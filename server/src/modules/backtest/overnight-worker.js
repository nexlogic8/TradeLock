// Worker thread for the "Overnight ATM CE + PE" backtest (see overnight.js): reads history.db and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import { overnightBacktest } from './overnight.js';

try { parentPort.postMessage({ result: overnightBacktest(workerData) }); }
catch (e) { parentPort.postMessage({ error: e.message, code: e.code }); }
