// Shared paths and ports for the regression harness. Nothing here is hard-coded to a machine.
// Ports come from TOWER_TEST_PORT_BASE (default 4890) and use a range of 10: base .. base+9.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.TOWER_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT_BASE = Number(process.env.TOWER_TEST_PORT_BASE ?? 4890);
export const PORT_RANGE = 10;
// Named slots. Scenarios run one after another, so a slot is reused but never shared at the same time.
export const P = { gw: 0, alpha: 1, gamma: 2, third: 3, origin: 4, evil: 5, never: 6, aux: 7, spare1: 8, spare2: 9 };
for (const k of Object.keys(P)) P[k] += PORT_BASE;
export const NODE = process.env.TOWER_TEST_NODE ?? process.execPath;
export const RUN_DIR = process.env.TOWER_TEST_TMP ?? resolve(ROOT, '.run');
