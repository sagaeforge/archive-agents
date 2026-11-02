import { describe, expect, it } from 'vitest';
import { createApi } from '../server/app.ts';
import { APP_CSP, guard, META_CSP, SAFE_HEADERS } from '../server/guard.ts';
import { loadFixture, rebase } from '../server/snapshot.ts';
import { freshness, staleIds, type Snapshot } from '../server/model/fact.ts';

const h = (o: Record<string, string>) => (n: string) => o[n];
const api = createApi();
const get = (path: string, headers: Record<string, string> = { host: '127.0.0.1:4816' }, method = 'GET') => api.request(`http://127.0.0.1:4816${path}`, { method, headers });

describe('Host, Origin and Fetch Metadata', () => {
  it.each([
    ['127.0.0.1:4816', undefined, undefined, null],
    ['localhost:4816', 'http://localhost:4816', undefined, null],
    ['evil.example.com', undefined, undefined, 'host_rejected'],
    ['127.0.0.1.evil.example.com:4816', undefined, undefined, 'host_rejected'],
    ['127.0.0.1:4816', 'http://evil.example.com', undefined, 'origin_rejected'],
    ['127.0.0.1:4816', 'null', undefined, 'origin_rejected'],
    ['127.0.0.1:4816', undefined, 'cross-site', 'cross_site_rejected'],
  ] as const)('host %s origin %s fetch-site %s -> %s', (host, origin, site, want) => {
    const hdr: Record<string, string> = { host };
    if (origin) hdr.origin = origin; if (site) hdr['sec-fetch-site'] = site;
    expect(guard(h(hdr))?.code ?? null).toBe(want);
  });
  it('a missing Host is rejected', () => { expect(guard(h({}))?.code).toBe('host_rejected'); });
  it('a cross-site navigation is allowed, a cross-site fetch is not', () => {
    expect(guard(h({ host: '127.0.0.1', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }))).toBeNull();
    expect(guard(h({ host: '127.0.0.1', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }))?.code).toBe('cross_site_rejected');
  });
});

describe('a foreign page', () => {
  const cross = { host: '127.0.0.1:4815', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
  it.each(['iframe', 'frame', 'embed', 'object'])('cannot load relief in an %s', (dest) => {
    expect(guard(h({ ...cross, 'sec-fetch-dest': dest }))?.code).toBe('cross_site_rejected');
  });
  it('may send a person to the map in a tab of its own', () => { expect(guard(h({ ...cross, 'sec-fetch-dest': 'document' }))).toBeNull(); });
  it('cannot navigate at the API, where a GET can cost a read of PVE', async () => {
    expect(guard(h({ ...cross, 'sec-fetch-dest': 'document' }), '/api/trend')?.code).toBe('cross_site_rejected');
    expect((await get('/api/trend?id=x', { ...cross, 'sec-fetch-dest': 'iframe' })).status).toBe(403);
    expect((await get('/api/snapshot', { ...cross, 'sec-fetch-dest': 'document' })).status).toBe(403);
  });
  it('a same-origin page is untouched', () => { expect(guard(h({ host: '127.0.0.1:4815', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), '/api/trend')).toBeNull(); });
  it('every response forbids framing', () => {
    expect(SAFE_HEADERS['X-Frame-Options']).toBe('DENY'); expect(SAFE_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(SAFE_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
});

describe('content security policy', () => {
  it('no page may frame relief, and the <meta> copy leaves out what a meta tag cannot carry', () => {
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(META_CSP).not.toContain('frame-ancestors');
  });
});

describe('/api/snapshot', () => {
  it('serves today with a layout for every object', async () => {
    const r = await get('/api/snapshot');
    expect(r.status).toBe(200);
    const s = (await r.json()) as Snapshot;
    expect(s.nodes).toHaveLength(16);
    for (const n of s.nodes) expect(s.layout[n.id]).toBeDefined();
  });
  it('serves large on request and refuses an unknown name', async () => {
    expect(((await (await get('/api/snapshot?fixture=large')).json()) as Snapshot).nodes).toHaveLength(299);
    expect((await get('/api/snapshot?fixture=../../etc/passwd')).status).toBe(404);
  });
  it('answers GET only', async () => {
    for (const m of ['POST', 'PUT', 'DELETE']) expect((await get('/api/snapshot', { host: '127.0.0.1:4816' }, m)).status, m).toBe(404);
  });
  it('rejects a foreign Host before any work', async () => {
    expect((await get('/api/snapshot', { host: 'evil.example.com' })).status).toBe(403);
    expect((await get('/api/snapshot', { host: '127.0.0.1:4816', origin: 'http://evil.example.com' })).status).toBe(403);
  });
  it('stays inside the size budget of design 13: 300 KB at 300 objects', async () => {
    const t = await (await get('/api/snapshot?fixture=large')).text();
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(300 * 1024);
  });
  it('carries no local path, home directory or secret-looking field', async () => {
    const t = await (await get('/api/snapshot?fixture=large')).text();
    expect(t).not.toMatch(/\/home\/|\/Users\/|token|password|secret/i);
  });
});

describe('rebase', () => {
  it('shifts every observed time so the fixture reads as fresh whenever it is served, and node 4 stays stale', async () => {
    const later = Date.now() + 5 * 365 * 86400_000;
    const s = await loadFixture('large', later);
    expect(Date.parse(s.takenAt)).toBe(later);
    const stale = staleIds(s, later);
    expect(stale.has('pve:node:node-4')).toBe(true); expect(stale.has('pve:node:node-1')).toBe(false);
    expect(freshness(s.nodes.find((n) => n.id === 'pve:node:node-1')!.facts.state!, later)).toBe('fresh');
  });
  it('leaves declaration dates alone', async () => {
    const s = await loadFixture('large');
    const wan = s.nodes.find((n) => n.kind === 'wan')!;
    expect(wan.facts.state!.at).toBe('2026-11-01');
    expect(rebase(s, Date.now()).nodes.find((n) => n.kind === 'wan')!.facts.state!.at).toBe('2026-11-01');
  });
});
