// Design 5, 19: the `local` adapter reads this machine from node:os only, and never takes a virtual interface.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickLan, readLocal, type LocalSource } from '../server/collect/local.ts';
import { sshOffer } from '../server/model/ssh.ts';

const nic = (address: string, o: Record<string, unknown> = {}) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24`, ...o });
const src = (ifaces: Record<string, unknown[]>, o: Partial<Record<keyof LocalSource, unknown>> = {}): LocalSource => ({
  hostname: () => 'pc-1', networkInterfaces: () => ifaces as never, availableParallelism: () => 8, totalmem: () => 16 * 2 ** 30, freemem: () => 4 * 2 ** 30, ...o }) as LocalSource;

describe('interface selection', () => {
  it('takes eth0', () => { expect(pickLan({ lo: [nic('127.0.0.1', { internal: true })], eth0: [nic('192.0.2.150')] } as never)).toBe('192.0.2.150'); });
  it.each(['docker0', 'veth1a2b3c', 'br-0123456789ab', 'virbr0', 'tailscale0', 'wg0', 'vEthernet (WSL)', 'lo', 'tun0', 'cni0', 'flannel.1', 'eth0:1', 'eth0 ', 'ｅth0'])('rejects %s, and with nothing else gives null', (name) => {
    expect(pickLan({ [name]: [nic('198.51.100.9')] } as never)).toBeNull();
  });
  it('picks a physical name over a virtual one whatever the order', () => {
    expect(pickLan({ docker0: [nic('198.51.100.1')], veth9: [nic('198.51.100.2')], enp3s0: [nic('192.0.2.7')] } as never)).toBe('192.0.2.7');
    expect(pickLan({ enp3s0: [nic('192.0.2.7')], eth0: [nic('192.0.2.8')] } as never)).toBe('192.0.2.8');
  });
  it('refuses loopback, link-local, multicast, internal, IPv6 and odd forms on an allowed name', () => {
    for (const a of ['127.0.0.1', '169.254.1.1', '224.0.0.1', '0.0.0.0', '010.0.0.1', '192.0.2.1%eth0', '192.0.2.1:22']) expect(pickLan({ eth0: [nic(a)] } as never), a).toBeNull();
    expect(pickLan({ eth0: [nic('192.0.2.5', { internal: true })] } as never)).toBeNull();
    expect(pickLan({ eth0: [nic('fe80::1', { family: 'IPv6' })] } as never)).toBeNull();
    expect(pickLan({ eth0: [nic('169.254.1.1'), nic('192.0.2.5')] } as never)).toBe('192.0.2.5');
  });
});

describe('readLocal', () => {
  it('reads hostname, address, cores and memory with its own time', () => {
    expect(readLocal(Date.parse('2026-11-02T00:00:00Z'), src({ eth0: [nic('192.0.2.150')] }))).toEqual({ hostname: 'pc-1', address: '192.0.2.150', cores: 8, memTotal: 16 * 2 ** 30, memFree: 4 * 2 ** 30, at: '2026-11-02T00:00:00.000Z' });
  });
  it('a hostile or impossible value becomes null, not text', () => {
    const r = readLocal(0, src({}, { hostname: () => '$(x);\n-oProxyCommand=x', availableParallelism: () => -1, totalmem: () => Number.NaN, freemem: () => 1 }));
    expect(r).toMatchObject({ hostname: null, address: null, cores: null, memTotal: null, memFree: null });
    expect(readLocal(0, src({}, { freemem: () => 99 * 2 ** 30 })).memFree).toBeNull();
  });
});

describe('no outside reach', () => {
  it('the adapter imports node:os and the gate only, and spawns and calls nothing', () => {
    const code = readFileSync(new URL('../server/collect/local.ts', import.meta.url), 'utf8');
    const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:os', '../model/guest.ts', '../model/ssh.ts']);
    expect(code).not.toMatch(/child_process|fetch\(|node:net\b|node:http|node:fs|undici|process\.env|execFile|spawn/);
  });
  it('the PC gets no SSH button and the panel says no SSH server is confirmed', () => {
    expect(sshOffer({ id: 'host:workstation', kind: 'workstation', title: 'Windows PC', basis: 'declared', state: 'ok', facts: {} })).toEqual({ why: 'SSH 서버가 확인되지 않았다' });
  });
});
