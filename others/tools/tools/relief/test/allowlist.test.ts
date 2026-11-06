// Design 6.3 and 12: what may be read is exact, and a refusal happens before the network.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { callOf, NotAllowed, PATHS, TOOLS, type Target } from '../server/collect/allowlist.ts';
import { closeRigs, rig } from './support/rig.ts';

afterEach(closeRigs);

const api = (path: string, params?: Record<string, string>) => ({ tool: 'proxmox_api_get', path, ...(params ? { params } : {}) }) as Target;

describe('tools', () => {
  it('are the four exact names', () => {
    expect([...TOOLS].sort()).toEqual(['proxmox_api_get', 'proxmox_guest_config', 'proxmox_list_resources', 'proxmox_recent_tasks']);
  });
  it.each(['kb_kb_put', 'kb_kb_request', 'proxmox_vm_stop', 'proxmox_cluster_overview', 'proxmox_node_status', 'proxmox_api_get ', 'PROXMOX_API_GET', '', 'proxmox_*'])('refuses %s', (tool) => {
    expect(() => callOf({ tool } as unknown as Target)).toThrow(NotAllowed);
  });
  it('refuses a target that is no target', () => {
    expect(() => callOf(null as unknown as Target)).toThrow(NotAllowed);
    expect(() => callOf({} as unknown as Target)).toThrow(NotAllowed);
  });
});

describe('paths', () => {
  it.each([
    '/cluster/status', '/cluster/metrics/export', '/cluster/sdn/zones', '/cluster/sdn/vnets', '/cluster/firewall/rules',
    '/nodes/node-1/network', '/nodes/node.1/dns', '/nodes/node_1/firewall/rules',
    '/nodes/node-1/qemu/100/agent/network-get-interfaces', '/nodes/node-1/qemu/100/agent/get-osinfo',
  ])('allows %s', (path) => { expect(callOf(api(path)).name).toBe('proxmox_api_get'); });
  it.each(['/nodes/node-1/rrddata', '/nodes/node-1/qemu/100/rrddata', '/nodes/node-1/lxc/101/rrddata'])('allows %s with timeframe=hour only', (path) => {
    expect(callOf(api(path, { timeframe: 'hour' })).args).toEqual({ path, params: { timeframe: 'hour' } });
    expect(() => callOf(api(path))).toThrow(NotAllowed);
    expect(() => callOf(api(path, { timeframe: 'year' }))).toThrow(NotAllowed);
    expect(() => callOf(api(path, { timeframe: 'hour', ds: 'cpu' }))).toThrow(NotAllowed);
  });
  it.each([
    '/nodes/x/report', '/nodes/x/syslog', '/nodes/x/status', '/nodes/x/qemu/100/config', '/nodes/x/qemu/100/status/stop', '/nodes/x/qemu/100/agent/exec',
    '/access/users', '/cluster/resources', '/cluster/status/', '/cluster/status?x=1', 'cluster/status', '//cluster/status', '/cluster/../nodes/x/report', '',
    '/nodes/../network', '/nodes/./dns', '/nodes/a b/network', '/nodes/a%2Fb/network', '/nodes/x/network\n', '/nodes/é/dns',
    '/nodes/x/qemu/0/agent/get-osinfo', '/nodes/x/qemu/-1/agent/get-osinfo', '/nodes/x/qemu/1.5/agent/get-osinfo', '/nodes/x/qemu/abc/agent/get-osinfo', '/nodes/x/lxc/100/agent/get-osinfo',
    '/nodes/x/qemu/1/../2/rrddata',
  ])('refuses %j', (path) => { expect(() => callOf(api(path))).toThrow(NotAllowed); });
  it('takes parameters on rrddata only', () => { expect(() => callOf(api('/cluster/status', { a: 'b' }))).toThrow(NotAllowed); });
  it('refuses a path that is not a string', () => { expect(() => callOf({ tool: 'proxmox_api_get', path: ['/cluster/status'] } as unknown as Target)).toThrow(NotAllowed); });
  it('each template in the design list resolves to itself as the call label', () => {
    expect(PATHS).toHaveLength(12);
    expect(callOf(api('/nodes/a/dns')).label).toBe('proxmox_api_get /nodes/{n}/dns');
  });
});

describe('guest_config', () => {
  it('passes a good target', () => { expect(callOf({ tool: 'proxmox_guest_config', node: 'n', vmid: 100, kind: 'lxc' }).args).toEqual({ node: 'n', vmid: 100, kind: 'lxc' }); });
  it.each([['../x', 100, 'qemu'], ['..', 100, 'qemu'], ['n', 0, 'qemu'], ['n', 1.5, 'qemu'], ['n', '100', 'qemu'], ['n', 100, 'vm'], ['a/b', 100, 'qemu']])('refuses %j %j %j', (node, vmid, kind) => {
    expect(() => callOf({ tool: 'proxmox_guest_config', node, vmid, kind } as unknown as Target)).toThrow(NotAllowed);
  });
});

describe('a refusal comes before the network', () => {
  it('sends nothing at all, not even a connect', async () => {
    const r = await rig();
    await expect(r.reader.read({ tool: 'kb_kb_put' } as unknown as Target)).rejects.toThrow(NotAllowed);
    await expect(r.reader.read(api('/nodes/x/report'))).rejects.toThrow(NotAllowed);
    expect(r.mock.requests.value).toBe(0);
    expect(r.reader.record).toMatchObject({ total: 0, refused: 2 });
  });
});

describe('source check', () => {
  const root = fileURLToPath(new URL('../server/', import.meta.url));
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it('the tool call exists at exactly one site, in collect/mcp.ts', () => {
    const sites = walk(root).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\.callTool\(/g)].map(() => f.slice(root.length)));
    expect(sites).toEqual(['collect/mcp.ts']);
  });
  it('the module exports no call by name', async () => {
    const m = await import('../server/collect/mcp.ts');
    expect(Object.keys(m).sort()).toEqual(['CONNECT_MS', 'DEADLINE_MS', 'MAX_BYTES', 'ReadError', 'classify', 'createReader']);
    const r = await rig();
    expect(Object.keys(r.reader).sort()).toEqual(['close', 'read', 'record']);
  });
  it('the Live and CLI code holds no tool name outside the allowlist', () => {
    for (const f of walk(root)) if (!f.endsWith('allowlist.ts')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/kb_|proxmox_(vm|cluster_overview|node_status)/);
  });
  it('the HTTP surface answers GET only', () => {
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).not.toMatch(/app\.(post|put|patch|delete)\(/);
  });
});
