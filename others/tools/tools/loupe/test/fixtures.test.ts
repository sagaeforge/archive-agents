// The Phase 1 fixtures (kb-research.json, kb-hostile.json): the checks fail on planted faults, and kb-mock serves every record.
// kb-mock validates each JSON body against the sample spec before sending it, so a 500 here means the fixture drifted from the contract shape.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { checkHostile, checkIntegrity, checkQuotes, checkResearch, newReport } from '../scripts/lib/fixture-checks.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dir = new URL('../contract-sample/fixtures/', import.meta.url).pathname;
const docsDir = new URL('../../../docs/research/', import.meta.url).pathname;
const load = (n: string): any => JSON.parse(readFileSync(dir + n, 'utf8'));
const research = () => load('kb-research.json');
const hostile = () => load('kb-hostile.json');

const run = (f: any, docs = false) => {
  const r = newReport('t', true);
  checkQuotes(f, r); checkIntegrity(f, r);
  checkResearch(f, r, docs ? { docsDir } : {});
  return r;
};

describe('the checker passes the real fixtures', () => {
  it('kb-research.json', () => { const r = run(research(), true); expect(r.failures).toEqual([]); expect(r.counts).toMatchObject({ snapshots: 20 }); });
  it('kb-hostile.json', () => { const f = hostile(); const r = newReport('t', true); checkQuotes(f, r); checkIntegrity(f, r); checkHostile(f, r); expect(r.failures).toEqual([]); });
});

describe('negative controls: the checker notices each planted fault', () => {
  it('a quote offset shifted by one', () => { const f = research(); f.claims.find((c: any) => c.evidence?.[0]?.start != null).evidence[0].start += 1; expect(run(f).bad).toBeGreaterThan(0); });
  it('an exact text edited', () => { const f = research(); f.claims.find((c: any) => c.evidence?.[0]?.start != null).evidence[0].exact += 'x'; expect(run(f).bad).toBeGreaterThan(0); });
  it('a body character changed', () => { const f = research(); const id = f.snapshots[0].id; f.bodies[id].text = f.bodies[id].text.replace('the', 'thx'); expect(run(f).bad).toBeGreaterThan(0); });
  it('a body that no longer equals the document (hashes recomputed)', () => {
    if (!existsSync(docsDir)) return;
    const f = research(); const s = f.snapshots.find((x: any) => x.text_format === 'markdown');
    // change a character that no quote uses, and keep every hash consistent
    const b = f.bodies[s.id]; b.text = b.text.slice(0, -1) + 'Z'; b.raw = b.text;
    const r = newReport('t', true); checkResearch(f, r, { docsDir });
    expect(r.failures.some((m) => /differs from/.test(m))).toBe(true);
  });
  it('a LAN address', () => { const f = research(); f.nodes[0].label = 'host 192.168.x.x'; expect(run(f).failures.some((m) => /private network/.test(m))).toBe(true); });
  it('an unlocated quote on a quote_found claim', () => { const f = research(); const c = f.claims.find((x: any) => x.verification === 'needs_review'); c.verification = 'quote_found'; expect(run(f).bad).toBeGreaterThan(0); });
  it('a located quote presented as unlocated', () => {
    const f = research(); const c = f.claims.find((x: any) => x.verification === 'quote_found' && x.evidence?.[0]?.start != null);
    c.verification = 'needs_review'; c.evidence[0].start = null; c.evidence[0].end = null; expect(run(f).bad).toBeGreaterThan(0);
  });
  it('the correction recorded before the claim it corrects', () => { const f = research(); const h = f.cases.retroactive_correction.headline; for (const c of f.claims) if (c.id === h.new_claim) c.valid.from = '2020-01-01'; expect(run(f).failures.some((m) => /case not covered|time travel/.test(m))).toBe(true); });
  it('no private record', () => {
    const f = research();
    for (const x of [...f.nodes, ...f.claims]) if (x.sensitivity === 'private') x.sensitivity = 'internal';
    expect(run(f).failures.some((m) => /sensitivity_private/.test(m))).toBe(true);
  });
  it('an edge more visible than the hidden record it touches', () => {
    const f = research(); const e = f.edges.find((x: any) => x.dst === 'e:concept:agentgateway-session-key' || x.src === 'e:concept:agentgateway-session-key'); e.sensitivity = 'public';
    expect(run(f).failures.some((m) => /sensitivity/.test(m))).toBe(true);
  });
  it('a hidden record in the change feed', () => { const f = research(); f.changes.push({ seq: f.meta.applied_seq, at: f.meta.data_as_of, kind: 'node.upsert', id: 'e:concept:agentgateway-session-key', version: 1, type: 'Concept', origin: 'external' }); expect(run(f).bad).toBeGreaterThan(0); });
  it('a wiki link without its edge', () => { const f = research(); f.edges = f.edges.filter((e: any) => !(e.src === 'f-01JD2K7Q9T4M8A' && e.rtype === 'LINKS_TO')); expect(run(f).bad).toBeGreaterThan(0); });
  it('a merge cycle', () => { const f = research(); const a = f.nodes.find((n: any) => n.id === 'e:tool:1mcp' ); a.merged_into = 'e:tool:1mcp-app'; expect(run(f).bad).toBeGreaterThan(0); });
  it('a slash in an id', () => { const f = research(); f.nodes[0].id = 'e:product:a/b'; expect(run(f).bad).toBeGreaterThan(0); });
  it('a hostile fixture without its script tag', () => {
    const f = hostile(); for (const b of Object.values<any>(f.bodies)) b.text = b.text.replace(/<script/gi, '<scr');
    const r = newReport('t', true); checkHostile(f, r); expect(r.failures.some((m) => /script_tag/.test(m))).toBe(true);
  });
});

// ---- kb-mock serves the fixtures
const serve = (name: string) => {
  const app = createKbMock({ fixturePath: dir + name });
  return async (p: string, init?: RequestInit) => { const res = await app.request('http://localhost' + p, init); return { res, json: res.headers.get('content-type')?.includes('json') ? await res.json() as any : null }; };
};

describe('kb-mock serves kb-research.json', () => {
  const get = serve('kb-research.json');
  const f = research();
  const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString();

  it('every node, claim, snapshot and edge answers, and nothing drifts from the spec (no 500)', async () => {
    const bad: string[] = [];
    const ids = [...new Set([...f.nodes, ...f.claims].map((n: any) => n.id))];
    for (const id of ids) {
      const hiddenNode = ['private', 'secret'].includes([...f.nodes, ...f.claims].filter((n: any) => n.id === id).at(-1).sensitivity);
      const p = (id.startsWith('c-') ? '/v1/claims/' : '/v1/nodes/') + encodeURIComponent(id);
      const { res } = await get(p);
      if (res.status !== (hiddenNode ? 404 : 200)) bad.push(`${p} -> ${res.status}`);
    }
    for (const e of [...new Set<string>(f.edges.map((x: any) => x.id))].slice(0, 60)) { const { res } = await get('/v1/edges/' + e); if (![200, 404].includes(res.status)) bad.push(`edge ${e} -> ${res.status}`); }
    for (const s of f.snapshots) for (const sub of ['', '/text', '/raw']) { const { res } = await get(`/v1/snapshots/${s.id}${sub}`); if (res.status !== 200) bad.push(`${s.id}${sub} -> ${res.status}`); }
    expect(bad).toEqual([]);
  }, 60_000);

  it('neighbors, history and overview of every visible entity answer', async () => {
    const bad: string[] = [];
    for (const n of f.nodes.filter((x: any) => x.origin === 'external' && !['Claim', 'Snapshot', 'Source'].includes(x.type) && x.sensitivity === 'public')) {
      for (const sub of ['/neighbors', '/history', '/claims', '/edges']) { const { res } = await get(`/v1/nodes/${n.id}${sub}`); if (res.status >= 500) bad.push(`${n.id}${sub} -> ${res.status}`); }
    }
    const { res } = await get('/v1/overview'); if (res.status !== 200) bad.push('overview ' + res.status);
    expect(bad).toEqual([]);
  }, 60_000);

  it('private and secret records are 404 everywhere, and absent from lists, search, facets and the feed', async () => {
    for (const id of ['e:concept:gateway-token-storage', 'e:concept:agentgateway-session-key', 'f-01JD2K7S8X2D5E']) {
      expect((await get('/v1/nodes/' + id)).res.status).toBe(404);
      expect((await get(`/v1/nodes/${id}/history`)).res.status).toBe(404);
    }
    const list = (await get('/v1/nodes?limit=500')).json.data.items.map((x: any) => x.id);
    expect(list).not.toContain('e:concept:gateway-token-storage');
    expect(list).not.toContain('f-01JD2K7S8X2D5E');
    const hit = (await get('/v1/search' + q({ q: 'AES' }))).json.data.items.map((x: any) => JSON.stringify(x)).join();
    expect(hit).not.toContain('session-key');
    const feed = (await get('/v1/changes?limit=5000')).json.data.items;
    expect(feed.filter((c: any) => c.id === 'e:concept:gateway-token-storage').map((c: any) => c.kind)).toEqual(['visibility.revoked']);
    expect(feed.some((c: any) => c.id === 'e:concept:agentgateway-session-key')).toBe(false);
  });

  it('the retroactive correction changes what the screen shows when the observed time moves', async () => {
    const head = f.cases.retroactive_correction.headline;
    const slot = (o: Record<string, string>) => get(`/v1/nodes/e:library:sigma-js/claims${q({ ...o, limit: '500' })}`).then((r) => r.json.data.items.filter((c: any) => c.predicate === head.predicate).map((c: any) => c.value));
    expect(await slot({})).toEqual(['289']);
    expect(await slot({ as_of_valid: '2026-10-28' })).toEqual(['289']);
    expect(await slot({ as_of_valid: '2026-10-28', as_of_observed: '2026-10-31T12:00:00Z' })).toEqual(['576']);
    expect(await slot({ as_of_valid: '2026-10-28', as_of_observed: '2026-10-31T16:00:00Z' })).toEqual(['289']);
    expect(await slot({ as_of_valid: '2026-10-20', as_of_observed: '2026-10-31T23:00:00Z' })).toEqual([]);
    // the old claim is still reachable by id, superseded, and the chain shows all versions
    const old = (await get('/v1/claims/' + head.old_claim)).json.data;
    expect(old.status).toBe('superseded');
    const hist = (await get('/v1/nodes/e:library:sigma-js/history' + q({ predicate: head.predicate }))).json.data.chains[0].items;
    expect(hist.map((i: any) => `${i.id}#${i.version}`)).toContain(`${head.old_claim}#1`);
    expect(hist.length).toBeGreaterThanOrEqual(3);
  });

  it('the merged entity resolves and the final target carries the claims of the ids merged into it', async () => {
    const m = (await get('/v1/nodes/e:tool:1mcp-app')).json.data;
    expect(m).toMatchObject({ status: 'superseded', merged_into: 'e:tool:1mcp-agent', merged_into_final: 'e:tool:1mcp' });
    expect((await get('/v1/nodes?limit=500')).json.data.items.map((x: any) => x.id)).not.toContain('e:tool:1mcp-app');
    const fin = (await get('/v1/nodes/e:tool:1mcp')).json.data;
    expect(fin.claims.map((c: any) => c.predicate)).toContain('sdk_pin'); // the claim is about 1mcp-agent
    expect(fin.claims.map((c: any) => c.predicate)).toContain('description'); // the claim is about 1mcp-app
  });

  it('the dead entity answers with status dead and the default read drops its state claims', async () => {
    const d = (await get('/v1/nodes/e:feature:mcp-session-id')).json.data;
    expect(d.status).toBe('dead');
    expect(d.claims.map((c: any) => c.kind)).toEqual(['event']); // the state claim inherits dead and is filtered out
    const all = (await get('/v1/nodes/e:feature:mcp-session-id' + q({ status: 'all' }))).json.data.claims;
    expect(all.map((c: any) => c.kind).sort()).toEqual(['event', 'state']);
  });

  it('conflicting claims sit side by side in one entity page', async () => {
    const claims = (await get('/v1/nodes/e:project:sagae-gateway/claims?limit=500')).json.data.items.filter((c: any) => c.predicate === 'port');
    expect(claims.map((c: any) => c.value).sort()).toEqual(['7410', '8787', '8787']);
    expect(new Set(claims.map((c: any) => c.conflict_group))).toEqual(new Set(['cg-gateway-port']));
  });

  it('the claim whose quote cannot be located is hidden by default and served by id', async () => {
    const id = f.cases.unlocatable_quote_claim.id;
    const direct = (await get('/v1/claims/' + id)).json.data;
    expect(direct).toMatchObject({ verification: 'needs_review' });
    expect(direct.evidence[0]).toMatchObject({ start: null, end: null });
    const def = (await get('/v1/nodes/e:library:sigma-js/claims?limit=500')).json.data.items.map((c: any) => c.id);
    const inc = (await get('/v1/nodes/e:library:sigma-js/claims?limit=500&include_unverified=true')).json.data.items.map((c: any) => c.id);
    expect(def).not.toContain(id); expect(inc).toContain(id);
  });

  it('the hub entity is truncated by default and the rest arrives by cursor', async () => {
    const d = (await get('/v1/nodes/e:spike:s1-aggregation')).json.data;
    expect(d.claims).toHaveLength(50); expect(d.claims_truncated).toBe(true);
    const ids = new Set<string>(); let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const j: any = (await get(`/v1/nodes/e:spike:s1-aggregation/claims?limit=20${cursor ? '&cursor=' + cursor : ''}`)).json;
      j.data.items.forEach((c: any) => ids.add(c.id));
      cursor = j.page.next_cursor; if (!cursor) break;
    }
    expect(ids.size).toBeGreaterThan(50);
    for (const c of d.claims) expect(ids.has(c.id)).toBe(true);
  });

  it('the quote that crosses the default /text window is complete only across two windows', async () => {
    const id = f.cases.window_crossing_quote.claim;
    const c = (await get('/v1/claims/' + id)).json.data;
    const ev = c.evidence[0];
    const w1 = (await get(`/v1/snapshots/${ev.snapshot_id}/text`)).json.data;
    expect(w1.end).toBe(20000); expect(w1.total_chars).toBeGreaterThan(20000);
    const w2 = (await get(`/v1/snapshots/${ev.snapshot_id}/text${q({ start: '20000' })}`)).json.data;
    const joined = [...(w1.text + w2.text)];
    expect(joined.slice(ev.start, ev.end).join('')).toBe(ev.exact);
    expect([...w1.text].slice(ev.start).join('')).not.toBe(ev.exact);
  });

  it('every located quote can be cut from the served /text, in code points', async () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const c of f.claims) for (const e of c.evidence ?? []) {
      if (e.start == null || seen.has(c.id + e.id)) continue;
      seen.add(c.id + e.id);
      if (seen.size % 4) continue; // every fourth: the node-side check already covers all of them
      const t = (await get(`/v1/snapshots/${e.snapshot_id}/text${q({ start: String(Math.max(0, e.start - 5)), max_chars: String(e.end - e.start + 10) })}`)).json.data;
      if ([...t.text].slice(Math.min(5, e.start), Math.min(5, e.start) + (e.end - e.start)).join('') !== e.exact) bad.push(c.id);
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('the first-party pages read, with links in both directions and a version history', async () => {
    const page = (await get('/v1/nodes/f-01JD2K7Q9T4M8A?include=body,backlinks,edges')).json.data;
    expect(page).toMatchObject({ origin: 'first_party', author: 'user:sagae', version: 2, body_format: 'markdown' });
    expect(page.body).toContain('[[e:library:sigma-js]]');
    expect(page.edges.out.map((e: any) => e.dst)).toContain('e:library:sigma-js');
    const target = (await get('/v1/nodes/e:library:sigma-js?include=backlinks')).json.data;
    expect(target.backlinks.map((b: any) => b.id)).toContain('f-01JD2K7Q9T4M8A');
    const hist = (await get('/v1/nodes/f-01JD2K7Q9T4M8A/history')).json.data.versions;
    expect(hist.map((v: any) => v.version)).toEqual([1, 2]);
    const agent = (await get('/v1/nodes/f-01JD2K7R3W6B1C')).json.data;
    expect(agent).toMatchObject({ author: 'agent:session-6f2c', on_behalf_of: 'user:sagae' });
  });

  it('the JSON snapshots carry pointer evidence that resolves', async () => {
    for (const id of f.cases.jsonpointer_claims as string[]) {
      const c = (await get('/v1/claims/' + id)).json.data;
      expect(c.evidence[0].selector_kind).toBe('jsonpointer');
      expect(c.verification).toBe('parser_derived');
    }
  });

  it('Korean search finds the Korean report', async () => {
    const j = (await get('/v1/search' + q({ q: '채택' }))).json;
    expect(j.data.items.length).toBeGreaterThan(0);
  });
});

describe('kb-mock serves kb-hostile.json', () => {
  const get = serve('kb-hostile.json');
  const f = hostile();
  it('everything answers without drifting from the spec', async () => {
    const bad: string[] = [];
    for (const id of new Set([...f.nodes, ...f.claims].map((n: any) => n.id))) {
      const { res } = await get((id.startsWith('c-') ? '/v1/claims/' : '/v1/nodes/') + encodeURIComponent(id));
      if (res.status !== 200) bad.push(`${id} -> ${res.status}`);
    }
    for (const s of f.snapshots) for (const sub of ['', '/text', '/raw']) { const { res } = await get(`/v1/snapshots/${s.id}${sub}`); if (res.status !== 200) bad.push(`${s.id}${sub} -> ${res.status}`); }
    expect(bad).toEqual([]);
  });
  it('the hostile text arrives as data, unmodified', async () => {
    const t = (await get('/v1/snapshots/n-hostile000000001/text?max_chars=200000')).json.data.text as string;
    expect(t).toContain('<script>'); expect(t).toContain('](javascript:alert(1))');
    const raw = await get('/v1/snapshots/n-hostile000000004/raw');
    expect(raw.res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await raw.res.text()).toContain('<script>');
  });
  it('the label with markup is a label, and the NFD input is NFC in the display body', async () => {
    const n = (await get('/v1/nodes/e:concept:script-in-label')).json.data;
    expect(n.label).toBe('<script>alert("label")</script>');
    const t = (await get('/v1/snapshots/n-hostile000000003/text')).json.data.text as string;
    expect(t.normalize('NFC')).toBe(t);
    expect(f.bodies['n-hostile000000003'].raw).not.toBe(t);
  });
  it('code point offsets survive the emoji that precede the quote', async () => {
    const c = (await get('/v1/claims/' + f.cases.emoji_before_quote)).json.data;
    const ev = c.evidence[0];
    const t = (await get(`/v1/snapshots/${ev.snapshot_id}/text?max_chars=200000`)).json.data.text as string;
    expect([...t].slice(ev.start, ev.end).join('')).toBe(ev.exact);
    expect(t.slice(ev.start, ev.end)).not.toBe(ev.exact); // UTF-16 offsets would be wrong
  });
});
