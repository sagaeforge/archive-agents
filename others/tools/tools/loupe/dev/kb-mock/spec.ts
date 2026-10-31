// Loads the OpenAPI document and builds ajv validators. Shared by kb-mock and the scripts.
// The contract is read in place from the KB (scripts/lib/contract-paths.mjs). Fixture paths are relative to this file so the folder can move.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { openapiPath } from '../../scripts/lib/contract-paths.mjs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;
const here = new URL('./', import.meta.url);

export const specPath: string = openapiPath;
export const fixturePath = process.env.KB_FIXTURES ?? new URL('../../contract-sample/fixtures/kb.json', here).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const doc: any = parse(readFileSync(specPath, 'utf8'));

const rewrite = (n: unknown, to: string): unknown =>
  Array.isArray(n) ? n.map((x) => rewrite(x, to))
  : n && typeof n === 'object'
    ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === '$ref' ? String(v).replace('#/components/schemas/', to) : rewrite(v, to)]))
    : n;

function makeAjv(opts: object) {
  // x-provisional and other x- marks are annotations, so strictSchema is off.
  const a = new Ajv2020({ allowUnionTypes: true, allErrors: true, strictSchema: false, strictTypes: false, ...opts });
  addFormats(a);
  a.addSchema({ $id: 'oas', $defs: rewrite(doc.components.schemas, '#/$defs/') as object });
  return a;
}
export const ajv = makeAjv({});
const paramAjv = makeAjv({ coerceTypes: true });
export const schema = (name: string) => ajv.compile({ $ref: `oas#/$defs/${name}` });
export const schemaOf = (s: unknown) => ajv.compile(rewrite(s, 'oas#/$defs/') as object);
export const resolveParam = (p: { $ref?: string }) => (p.$ref ? doc.components.parameters[p.$ref.split('/').pop() as string] : p);
// Query and path values are strings. Wrapping them in an object lets ajv coerce them.
export const compileParam = (s: unknown) => {
  const f = paramAjv.compile({ type: 'object', properties: { x: rewrite(s, 'oas#/$defs/') } });
  return (x: unknown) => f({ x });
};

export type Op = { method: string; path: string; operationId: string; params: ReturnType<typeof resolveParam>[]; op: any };
export const operations = (): Op[] => {
  const out: Op[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths))
    for (const [method, op] of Object.entries<any>(item))
      if (['get', 'put', 'post', 'delete', 'patch', 'head'].includes(method))
        out.push({ method, path, operationId: op.operationId, op, params: [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveParam) });
  return out;
};
