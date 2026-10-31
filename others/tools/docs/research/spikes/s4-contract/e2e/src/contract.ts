// Loads the OpenAPI document and builds ajv validators. Shared by the mock and the fixture check.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;

const ROOT = new URL('../../contract/', import.meta.url).pathname;
export const doc: any = parse(readFileSync(process.env.KB_SPEC ?? ROOT + 'openapi.yaml', 'utf8'));
export const fixturePath = process.env.KB_FIXTURES ?? ROOT + 'fixtures/kb.json';

const rewrite = (n: any): any =>
  Array.isArray(n) ? n.map(rewrite)
  : n && typeof n === 'object'
    ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === '$ref' ? String(v).replace('#/components/schemas/', '#/$defs/') : rewrite(v)]))
    : n;
const bundle = { $id: 'oas', $defs: rewrite(doc.components.schemas) };

function makeAjv(opts: object) {
  // discriminator with mapping is rejected by ajv's own discriminator:true option, so it stays an
  // annotation and oneOf does the validation.
  const a = new Ajv2020({ allowUnionTypes: true, allErrors: true, ...opts });
  addFormats(a);
  a.addKeyword('discriminator');
  a.addSchema(bundle);
  return a;
}
export const ajv = makeAjv({});
export const paramAjv = makeAjv({ coerceTypes: true });
export const schema = (name: string) => ajv.compile({ $ref: `oas#/$defs/${name}` });
export const resolveParam = (p: any) => p.$ref ? doc.components.parameters[p.$ref.split('/').pop()] : p;
const rewriteExternal = (n: any): any =>
  Array.isArray(n) ? n.map(rewriteExternal)
  : n && typeof n === 'object'
    ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === '$ref' ? String(v).replace('#/components/schemas/', 'oas#/$defs/') : rewriteExternal(v)]))
    : n;
// Query and path values are strings. Wrapping in a parent lets ajv coerce them in place.
export const compileParam = (s: any) => {
  const f = paramAjv.compile({ type: 'object', properties: { x: rewriteExternal(s) } });
  return (x: unknown) => f({ x });
};
