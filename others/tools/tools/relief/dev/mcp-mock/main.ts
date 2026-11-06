// `npm run mock`: the mock on 127.0.0.1:4817, plus a throwaway config so `relief serve` can reach it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_PORT, startMock } from './mock.ts';

const dir = fileURLToPath(new URL('../../.cache/mock-config/', import.meta.url));
const token = randomBytes(24).toString('hex');
mkdirSync(join(dir, 'tower'), { recursive: true });
writeFileSync(join(dir, 'tower/token'), token, { mode: 0o600 });
writeFileSync(join(dir, 'relief.json'), JSON.stringify({ towerUrl: `http://127.0.0.1:${MOCK_PORT}/mcp` }));
await startMock({ token });
console.log(`mcp-mock on http://127.0.0.1:${MOCK_PORT}/mcp\nrelief against it: TOWER_CONFIG=${join(dir, 'tower/tower.json')} RELIEF_CONFIG=${dir} RELIEF_STATE=${join(dir, 'state')} node bin/relief.mjs serve`);
