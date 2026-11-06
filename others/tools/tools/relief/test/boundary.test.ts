// Design 6.4 and 12, data-boundary row: results are data. Chosen fields in, nothing else, and nothing from them steers a call.
import { afterEach, describe, expect, it } from 'vitest';
import { checkNoFake } from '../server/model/rules.ts';
import { validateSnapshot } from '../server/model/fact.ts';
import { toConfig } from '../server/collect/pve.ts';
import { clean } from '../server/model/normalize.ts';
import { closeRigs, rig, type Rig } from './support/rig.ts';

afterEach(closeRigs);

const noisy = (r: Rig, name: unknown, vmid: unknown) => {
  const base = { id: 'x', type: 'qemu', status: 'running', uptime: 9000, cpu: 0.1, mem: 1, maxmem: 2, disk: 0, maxdisk: 2 };
  r.mock.state.over.set('proxmox_list_resources', { json: [
    { id: `node/${String(name)}`, type: 'node', node: name, status: 'online', cpu: 0.1, mem: 1, maxmem: 2, disk: 1, maxdisk: 2 },
    { ...base, id: 'qemu/x', node: name, vmid, name: 'guest' },
  ] });
};

describe('chosen fields only', () => {
  it('cipassword, sshkeys, description and hookscript reach neither the snapshot nor the state file', async () => {
    const r = await rig();
    await r.live.collectOnce();
    await r.live.stop();
    const all = JSON.stringify(r.snap()) + r.file('state.json') + r.file('changes.jsonl');
    expect(r.mock.calls.some((c) => c.name === 'proxmox_guest_config')).toBe(true);
    for (const s of ['mock-ci-password', 'mock-ssh-key', 'mock-description-text', 'mock-hook', 'cipassword', 'sshkeys', 'hookscript', 'description']) expect(all).not.toContain(s);
    // Nor the MAC of the NIC, the user of a task, or an unasked counter.
    for (const s of ['02:00:00:00:00:01', 'root@pam', 'netin', 'diskread', 'UPID']) expect(all).not.toContain(s);
  });
  it('a failed task keeps its result and loses its text, which can hold a whole command line', async () => {
    const r = await rig();
    r.mock.state.tasks = [{ node: 'node-1', id: '100', type: 'qmstart', starttime: 1790000000, endtime: 1790000001, status: "command '/usr/bin/kvm -secret MOCKTEXT' failed: exit code 1" }];
    await r.live.collectOnce();
    expect(r.entity('pve:qemu:100')?.state).toBe('error');
    expect(JSON.stringify(r.snap()) + r.file('state.json')).not.toContain('MOCKTEXT');
  });
  it('toConfig takes the wiring of a NIC and the store of a disk', () => {
    expect(toConfig({ net0: 'virtio=02:00:00:00:00:01,bridge=vmbr0,firewall=1,tag=20', scsi0: 'local-lvm:vm-1,size=1G', ide2: 'local:iso/x.iso,media=cdrom', cores: 2, memory: '2048' }))
      .toEqual({ nics: [{ key: 'net0', bridge: 'vmbr0', tag: 20, firewall: true, ip: null }], disks: ['local-lvm'], ostype: null, cores: 2, memoryMb: 2048 });
    expect(toConfig({ net0: 'name=eth0,bridge=vmbr0,ip=192.0.2.9/24', rootfs: 'local:1' }).nics[0]!.ip).toBe('192.0.2.9/24');
  });
  it('a title is cut and stripped of control characters', () => {
    expect(clean(`a\u0000b\nc${'x'.repeat(100)}`)).toHaveLength(64);
    expect(clean('a\u0000b')).toBe('a b');
  });
});

describe('nothing from a result steers a call', () => {
  it.each(['../evil', '..', 'a/b', 'a b', 'x?y=1'])('a node named %j gets no node call, and says why', async (name) => {
    const r = await rig();
    noisy(r, name, 100);
    await r.live.collectOnce();
    for (const c of r.mock.calls) expect(JSON.stringify(c.args)).not.toContain(name.includes('/') || name === '..' ? name : `/nodes/${name}/`);
    const n = r.snap().nodes.find((e) => e.kind === 'node');
    expect(n?.facts.network).toMatchObject({ basis: 'unknown', why: '이름이 경로 규칙에 맞지 않아 읽지 않았다' });
    expect(validateSnapshot(r.snap())).toEqual([]);
  });
  it.each([[1.5], [-3], [0], ['100; rm -rf /'], ['abc']])('a vmid of %j gets no guest call, and says why', async (vmid) => {
    const r = await rig();
    noisy(r, 'node-1', vmid);
    await r.live.collectOnce();
    expect(r.mock.calls.filter((c) => c.name === 'proxmox_guest_config')).toEqual([]);
    expect(r.mock.calls.filter((c) => String(c.args.path).includes('/agent/'))).toEqual([]);
    expect(r.snap().nodes.find((e) => e.kind === 'vm')?.facts.nic).toMatchObject({ basis: 'unknown', why: '이름이 경로 규칙에 맞지 않아 읽지 않았다' });
  });
});

describe('a broken answer is a failure, never an empty list', () => {
  it.each([
    ['broken JSON', { text: '{ not json' }, '응답이 JSON이 아니다'],
    ['an object for a list', { json: { nope: 1 } }, '응답 모양이 다르다'],
    ['a row of the wrong type', { json: [{ type: 1, id: 2 }] }, '응답 모양이 다르다'],
    ['an empty text', { text: '' }, '응답이 JSON이 아니다'],
  ])('%s on the inventory', async (_n, answer, why) => {
    const r = await rig();
    await r.live.collectOnce();
    const before = r.snap().nodes.length;
    r.mock.state.over.set('proxmox_list_resources', answer);
    await r.live.collectOnce();
    expect(r.snap().sources[0]).toMatchObject({ state: 'failing', why });
    expect(r.snap().nodes).toHaveLength(before);
    expect(r.snap().nodes.some((n) => n.gone)).toBe(false);
  });
  it('an answer over the limit is refused', async () => {
    const r = await rig();
    r.mock.state.over.set('proxmox_list_resources', { text: `"${'x'.repeat(2 * 1024 * 1024 + 1)}"` });
    await r.live.collectOnce();
    expect(r.snap().sources[0]).toMatchObject({ state: 'failing', why: '응답이 2 MiB를 넘는다' });
  });
  it('the live snapshot passes the same checks as a fixture', async () => {
    const r = await rig();
    await r.live.collectOnce();
    expect(validateSnapshot(r.snap())).toEqual([]);
    expect(checkNoFake(r.snap())).toEqual([]);
    for (const n of r.snap().nodes) expect(r.snap().layout[n.id], n.id).toBeDefined();
  });
});
