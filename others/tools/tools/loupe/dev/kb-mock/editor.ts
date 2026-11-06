// Opt-in M0a data: a first-party page written by another author (`f:agent:intruder`) whose body is hostile Markdown. The editor opens it as
// text only (design v2 4.5). The body is test/fixtures/editor/hostile-body.md, so the unit test and the browser test read one source.
import { readFileSync } from 'node:fs';
import type { NodeDetail } from '../../src/client/model/index.ts';
const body = readFileSync(new URL('../../test/fixtures/editor/hostile-body.md', import.meta.url), 'utf8');
export const editorFixtures: NodeDetail[] = [
  { id: 'f-m0a-hostile', type: 'Page', label: 'M0a 다른 작성자의 문서', origin: 'first_party', sensitivity: 'internal', status: 'active', version: 1,
    recorded_at: '2026-01-01T00:00:00Z', valid: { from: null, to: null }, domain: [], props: { author: 'f:agent:intruder' }, claims: [],
    edges: { in: [], out: [], truncated: false }, backlinks: [], body, body_format: 'markdown' } as NodeDetail,
];
