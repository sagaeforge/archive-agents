// relief-v2 Phase 0: the PVE link goes straight to the node, from what relief observed, and takes no input.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Basis, Entity, Fact } from '../server/model/fact.ts';
import { pveLink } from '../server/model/pvelink.ts';

const fact = (value: unknown, basis: Basis = 'observed', source = 'pve:/cluster/status'): Fact<unknown> => ({ value, basis, source, at: '2026-11-01T00:00:00.000Z', ttlS: 45 });
const node = (address?: Fact<unknown>, id = 'pve:node:node-1'): Entity => ({ id, kind: 'node', title: 'n', state: 'ok', basis: 'observed', facts: address ? { address } : {} });
const guest = (id: string, kind: 'vm' | 'lxc' = 'vm'): Entity => ({ id, kind, title: 'g', parent: 'pve:node:node-1', state: 'running', basis: 'observed', facts: {} });
const good = node(fact('192.0.2.11'));

describe('the link', () => {
  it('goes to the node itself, on the PVE port', () => { expect(pveLink(good, [good])).toEqual({ url: 'https://192.0.2.11:8006/#v1:0:=node%2Fnode-1' }); });
  it('a VM opens on its node, at itself', () => { expect(pveLink(guest('pve:qemu:100'), [good])).toEqual({ url: 'https://192.0.2.11:8006/#v1:0:=qemu%2F100' }); });
  it('an LXC too', () => { expect(pveLink(guest('pve:lxc:101', 'lxc'), [good])).toEqual({ url: 'https://192.0.2.11:8006/#v1:0:=lxc%2F101' }); });
  it('a bridge, a storage, a router have none', () => {
    for (const kind of ['bridge', 'storage', 'gateway', 'workstation'] as const) expect(pveLink({ ...good, kind }, [good])).toBeNull();
  });
  it('an address with a prefix loses it', () => { expect(pveLink(node(fact('192.0.2.11/24')), [])).toMatchObject({ url: expect.stringContaining('https://192.0.2.11:8006/') }); });
});

describe('what it refuses', () => {
  it.each([['8.8.8.8'], ['127.0.0.1'], ['169.254.1.1'], ['100.64.0.1'], ['evil.example.com'], ['192.0.2.11@evil.example.com'], ['192.0.2.1/../x'], ['010.0.0.1'], ['192.0.2.11:9'], [''], ['[::1]']])('address %j gives no link', (a) => {
    expect(pveLink(node(fact(a)), [])).toEqual({ why: '노드 주소를 관측하지 못했다' });
  });
  it('a value that is no text gives none', () => { expect(pveLink(node(fact(5)), [])).toHaveProperty('why'); });
  it('a declared or derived address gives none', () => {
    expect(pveLink(node(fact('192.0.2.11', 'declared')), [])).toHaveProperty('why');
    expect(pveLink(node(fact('192.0.2.11', 'derived')), [])).toHaveProperty('why');
  });
  it('an address from anywhere but Proxmox gives none: a guest can say what it likes', () => { expect(pveLink(node(fact('192.0.2.11', 'observed', 'local:os')), [])).toHaveProperty('why'); });
  it('no address gives none', () => { expect(pveLink(node(), [])).toHaveProperty('why'); });
  it('a guest on a node relief does not know gives none', () => { expect(pveLink(guest('pve:qemu:100'), [])).toEqual({ why: '노드를 모른다' }); });
  it('a node name that is not a name gives none', () => { expect(pveLink(node(fact('192.0.2.11'), 'pve:node:../x'), [])).toHaveProperty('why'); });
  it('a guest number that is not one gives none', () => { expect(pveLink(guest('pve:qemu:1;x'), [good])).toEqual({ why: '게스트 번호가 규칙에 맞지 않는다' }); });
});

describe('no new surface', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  it('the server has no route for it', () => { expect(read('../server/app.ts')).not.toMatch(/pve|8006/i); });
  it('the module fetches nothing and takes no URL', () => { expect(read('../server/model/pvelink.ts')).not.toMatch(/fetch\(|node:|location|window/); });
  it('the link cannot reach back into relief', () => {
    const t = read('../src/ui/detail.tsx');
    expect(t).toContain('rel="noopener noreferrer"'); expect(t).toContain('referrerPolicy="no-referrer"');
  });
});
