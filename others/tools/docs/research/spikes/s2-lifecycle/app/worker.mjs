import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
parentPort.on('message', ({ id, ms }) => { const e = performance.now() + ms; while (performance.now() < e); parentPort.postMessage({ id }); });
void DatabaseSync;
