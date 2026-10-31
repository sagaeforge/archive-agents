// Fails when the generated client no longer matches the contract the KB publishes (design 8, T1 and every 0.x change).
// The stamp hashes both the machine contract (openapi.yaml) and the prose contract, so a prose-only change is caught too.
import { readFileSync } from 'node:fs';
import { checkStamp } from './lib/stamp-check.mjs';
import { openapiPath, prosePath } from './lib/contract-paths.mjs';

const text = readFileSync(new URL('../src/client/stamp.ts', import.meta.url), 'utf8');
const json = /CONTRACT_STAMP = (\{[\s\S]*?\n\}) as const/.exec(text)?.[1];
if (!json) { console.error('contract:guard FAILED: src/client/stamp.ts has no stamp. Run npm run contract:gen.'); process.exit(1); }
const problems = checkStamp(JSON.parse(json), { openapi: openapiPath, prose: prosePath });
if (problems.length === 0) { console.log('contract:guard ok: the client matches the live contract'); process.exit(0); }
console.error(`contract:guard FAILED:\n  ${problems.join('\n  ')}\nRegenerate (npm run contract:gen), read the diff, fix what the diff breaks, then run the flow again (design 8).`);
process.exit(1);
