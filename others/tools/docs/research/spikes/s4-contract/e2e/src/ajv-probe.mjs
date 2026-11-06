import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const doc = parse(readFileSync('../contract/openapi.yaml', 'utf8'));
const rewrite = (n) => Array.isArray(n) ? n.map(rewrite) : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === '$ref' ? v.replace('#/components/schemas/', '#/$defs/') : rewrite(v)])) : n;
const bundle = { $id: 'oas', $defs: rewrite(doc.components.schemas) };
const f = JSON.parse(readFileSync('../contract/fixtures/kb.json', 'utf8'));
const tryOpts = (name, opts, pre) => {
  try {
    const a = new Ajv2020(opts); addFormats(a); pre?.(a);
    a.addSchema(bundle);
    const v = a.compile({ $ref: 'oas#/$defs/Claim' });
    const good = f.claims.every(c => v(c));
    const bad = v({ ...f.claims[0], value: { value_type: 'number', value: 'x' } });
    const firstErr = (v(({ ...f.claims[0], value: { value_type: 'number', value: 'x' } })), v.errors?.length);
    console.log(name, '=> compiled, fixtures ok:', good, ', bad rejected:', !bad, ', error count on bad:', firstErr);
  } catch (e) { console.log(name, '=> THROW:', e.message.slice(0, 150)); }
};
tryOpts('A strict default', {});
tryOpts('B strict + discriminator:true', { discriminator: true });
tryOpts('C strict + allowUnionTypes', { allowUnionTypes: true });
tryOpts('D allowUnion + discriminator:true', { allowUnionTypes: true, discriminator: true });
tryOpts('E allowUnion + keyword discriminator as annotation', { allowUnionTypes: true }, a => a.addKeyword('discriminator'));
tryOpts('F strict:false', { strict: false });
