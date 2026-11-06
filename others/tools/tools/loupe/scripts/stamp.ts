// Runs after Orval (clean:true wipes src/client). Writes src/client/stamp.ts: contract names, versions and sha256 of the live files.
// The hashes are of the files themselves, not of anything the YAML says about itself, so a changed contract changes the stamp.
// Only repository-relative names are written: the stamp is bundled, and a local path would ship with it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { OPENAPI_NAME, PROSE_NAME, openapiPath, prosePath } from './lib/contract-paths.mjs';

const root = new URL('../', import.meta.url);
const text = readFileSync(openapiPath);
const prose = readFileSync(prosePath);
const doc = parse(text.toString('utf8'));
const orval = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('orval/package.json'), 'utf8')).version as string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const stamp = {
  input: OPENAPI_NAME,
  inputSha256: sha(text),
  proseDocument: PROSE_NAME,
  proseSha256: sha(prose),
  specVersion: String(doc.info?.version ?? ''),
  schemaVersion: String(doc.info?.version ?? ''),
  generator: `orval@${orval}`,
};
writeFileSync(new URL('src/client/stamp.ts', root), `// Written by scripts/stamp.ts. Do not edit.\nexport const CONTRACT_STAMP = ${JSON.stringify(stamp, null, 2)} as const;\n`);
console.log('stamp', stamp.input, stamp.inputSha256.slice(0, 12), 'prose', stamp.proseSha256.slice(0, 12), stamp.generator);
