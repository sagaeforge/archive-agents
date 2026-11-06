// Design 12, no-write row: the mock advertises write tools, and a full collection calls none of them.
import { afterEach, describe, expect, it } from 'vitest';
import { hint } from '../dev/mcp-mock/mock.ts';
import { TOOLS, callOf, type Target } from '../server/collect/allowlist.ts';
import { closeRigs, rig } from './support/rig.ts';

afterEach(closeRigs);

describe('a full collection', () => {
  it('makes 0 calls to kb_kb_put or proxmox_vm_stop, though both are advertised', async () => {
    const r = await rig();
    expect(r.mock.state.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['kb_kb_put', 'kb_kb_request', 'proxmox_vm_stop']));
    await r.live.collectOnce();
    expect(r.mock.calls.length).toBeGreaterThan(10);
    const names = new Set(r.mock.calls.map((c) => c.name));
    expect(names.has('kb_kb_put')).toBe(false);
    expect(names.has('kb_kb_request')).toBe(false);
    expect(names.has('proxmox_vm_stop')).toBe(false);
    expect([...names].every((n) => (TOOLS as readonly string[]).includes(n))).toBe(true);
    expect(r.snap().sources.find((s) => s.id === 'pve')?.state).toBe('ok');
  });
  it('every call the mock saw passes the allowlist again', async () => {
    const r = await rig();
    await r.live.collectOnce();
    for (const c of r.mock.calls) expect(() => callOf({ tool: c.name, ...c.args } as unknown as Target)).not.toThrow();
  });
  it('touches every tool, and only rrddata-free paths in the loops', async () => {
    const r = await rig();
    await r.live.collectOnce();
    expect(new Set(r.mock.calls.map((c) => c.name))).toEqual(new Set(TOOLS));
    expect(r.mock.calls.some((c) => String(c.args.path).endsWith('/rrddata'))).toBe(false);
  });
});

describe('a panel reading a trend', () => {
  it('passes the allowlist again, with write tools still advertised and never called', async () => {
    const r = await rig();
    await r.live.collectOnce();
    r.mock.calls.length = 0;
    await r.live.trend('pve:node:node-1', 'hour'); await r.live.trend('pve:qemu:100', 'day');
    expect(r.mock.calls.map((c) => c.name)).toEqual(['proxmox_api_get', 'proxmox_api_get']);
    for (const c of r.mock.calls) expect(() => callOf({ tool: c.name, ...c.args } as unknown as Target)).not.toThrow();
    expect(r.live.status().calls.refused).toBe(0);
  });
});

describe('readOnlyHint', () => {
  it.each(TOOLS)('without it on %s nothing is called and the source fails', async (name) => {
    const r = await rig();
    r.mock.state.tools = r.mock.state.tools.map((t) => (t.name === name ? hint(name, false) : t));
    await r.live.collectOnce();
    expect(r.mock.calls).toEqual([]);
    expect(r.snap().sources.find((s) => s.id === 'pve')).toMatchObject({ state: 'failing', why: '읽기 도구 확인 안 됨' });
  });
});
