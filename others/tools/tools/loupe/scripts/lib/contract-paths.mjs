// Where the KB publishes its contract. Nothing in this repository copies it (CLAUDE.md): generation, the mock and the checks read it in place.
// KB_CONTRACTS_DIR moves the directory. KB_CONTRACT points at one OpenAPI file (tests use it).
import { join } from 'node:path';

export const contractsDir = process.env.KB_CONTRACTS_DIR ?? '/home/user/sagae-knowloge-base/docs/contracts';
export const openapiPath = process.env.KB_CONTRACT ?? join(contractsDir, 'openapi.yaml');
export const prosePath = join(contractsDir, 'data-interface-v0.md');
// Names written into the stamp, which ships in the bundle. Repository-relative names only: no home directory, no checkout location.
export const OPENAPI_NAME = 'docs/contracts/openapi.yaml';
export const PROSE_NAME = 'docs/contracts/data-interface-v0.md';
