// A stand-in for tower's /mcp with a synthetic cluster (design 11, 12). Names are invented, addresses are RFC 5737. It advertises write tools on purpose: relief must not call them.
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

export const MOCK_PORT = 4817;

const NODES = ['node-1', 'node-2', 'node-3'];
export const hint = (name: string, readOnly = true) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} }, ...(readOnly ? { annotations: { readOnlyHint: true, openWorldHint: false } } : {}) });
export const DEFAULT_TOOLS = () => [
  hint('proxmox_list_resources'), hint('proxmox_recent_tasks'), hint('proxmox_guest_config'), hint('proxmox_api_get'),
  hint('proxmox_cluster_overview'), hint('proxmox_node_status'),
  hint('kb_kb_put', false), hint('kb_kb_request', false), hint('proxmox_vm_stop', false),
];

export type Guest = { vmid: number; node: string; name: string; status: string; type: 'qemu' | 'lxc'; uptime?: number; agent?: boolean };
export type Answer = { json: unknown } | { isError: string } | { text: string } | { protocol: string };

export type MockState = {
  http: number | null; hang: boolean; tools: ReturnType<typeof DEFAULT_TOOLS>;
  guests: Guest[]; tasks: Record<string, unknown>[]; cpu: number;
  /** Byte counters of every node and guest: both at `value`, read at PVE time `t`. Each metrics read adds `step` seconds at `rate` bytes a second. */
  net: { value: number; t: number; step: number; rate: number };
  /** Replaces the answer for one tool or api path. */
  over: Map<string, Answer>;
  /** What every read answers, ahead of `over`. */
  all: Answer | null;
};

export const freshState = (): MockState => ({
  http: null, hang: false, tools: DEFAULT_TOOLS(), cpu: 0.05, over: new Map(), all: null, net: { value: 1e6, t: 1790000000, step: 15, rate: 2000 },
  guests: [{ vmid: 100, node: 'node-1', name: 'guest-a', status: 'running', type: 'qemu', uptime: 7200, agent: true }],
  // A console session its node lost: no status, no endtime, days old. The live cluster has one of these.
  tasks: [
    { upid: 'UPID:node-1:1:1:1:aptupdate::root@pam:', node: 'node-1', id: '', type: 'aptupdate', user: 'root@pam', starttime: 1790000100, endtime: 1790000103, status: 'OK', saved: '1' },
    { upid: 'UPID:node-2:1:1:1:vncshell::root@pam:', node: 'node-2', id: '', type: 'vncshell', user: 'root@pam', starttime: 1790000000, pid: 42, saved: '0' },
  ],
});

function resources(s: MockState) {
  return [
    ...s.guests.map((g) => ({ id: `${g.type}/${g.vmid}`, type: g.type, vmid: g.vmid, node: g.node, name: g.name, status: g.status, template: 0, uptime: g.status === 'running' ? (g.uptime ?? 7200) : 0, cpu: g.status === 'running' ? s.cpu : 0, maxcpu: 2, mem: 2 ** 31, maxmem: 2 ** 32, disk: 0, maxdisk: 2 ** 35, netin: 1, netout: 1, diskread: 1, diskwrite: 1 })),
    ...NODES.map((n) => ({ id: `node/${n}`, type: 'node', node: n, status: 'online', level: '', uptime: 90000, cpu: s.cpu, maxcpu: 16, mem: 2 ** 32, maxmem: 2 ** 34, disk: 2 ** 32, maxdisk: 2 ** 36, 'cgroup-mode': 2 })),
    ...NODES.flatMap((n) => ['local', 'local-lvm'].map((st) => ({ id: `storage/${n}/${st}`, type: 'storage', node: n, storage: st, status: 'available', plugintype: 'dir', content: 'images', shared: 0, disk: 2 ** 30, maxdisk: 2 ** 36 }))),
    ...NODES.map((n) => ({ id: `network/${n}/zone/localnetwork`, type: 'network', node: n, network: 'localnetwork', 'network-type': 'zone', status: 'ok' })),
  ];
}

const addr = (n: string) => `192.0.2.${10 + NODES.indexOf(n)}`;

function apiGet(s: MockState, path: string): Answer {
  let m: RegExpExecArray | null;
  if (path === '/cluster/status') return { json: [{ type: 'cluster', id: 'cluster', name: 'example-cluster', nodes: 3, quorate: 1, version: 3 }, ...NODES.map((n, i) => ({ type: 'node', id: `node/${n}`, name: n, ip: addr(n), online: 1, local: 0, level: '', nodeid: i + 1 }))] };
  if (path === '/cluster/metrics/export') {
    s.net.t += s.net.step; s.net.value += s.net.rate * s.net.step;
    const net = (id: string) => [{ id, metric: 'net_in', value: s.net.value, timestamp: s.net.t, type: 'derive' }, { id, metric: 'net_out', value: s.net.value / 2, timestamp: s.net.t, type: 'derive' }];
    return { json: { data: [...NODES.flatMap((n) => [{ id: `node/${n}`, metric: 'cpu_current', value: s.cpu, timestamp: s.net.t, type: 'gauge' }, { id: `node/${n}`, metric: 'mem_used', value: 2 ** 32, timestamp: s.net.t, type: 'gauge' }, { id: `node/${n}`, metric: 'mem_total', value: 2 ** 34, timestamp: s.net.t, type: 'gauge' }, ...net(`node/${n}`)]), ...s.guests.filter((g) => g.status === 'running').flatMap((g) => net(`${g.type}/${g.vmid}`))] } };
  }
  if (['/cluster/sdn/zones', '/cluster/sdn/vnets', '/cluster/firewall/rules'].includes(path)) return { json: [] };
  if ((m = /^\/nodes\/([^/]+)\/network$/.exec(path))) return { json: [{ iface: 'vmbr0', type: 'bridge', active: 1, autostart: 1, method: 'static', method6: 'manual', cidr: `${addr(m[1]!)}/24`, address: addr(m[1]!), netmask: '24', gateway: '192.0.2.1', bridge_ports: 'nic1', families: ['inet'], priority: 4 }, { iface: 'nic1', type: 'eth', active: 1, method: 'manual', exists: 1, altnames: ['enp1s0'] }] };
  if (/^\/nodes\/[^/]+\/dns$/.test(path)) return { json: { dns1: '198.51.100.53', search: 'example.com' } };
  if (/^\/nodes\/[^/]+\/firewall\/rules$/.test(path)) return { json: [] };
  if ((m = /\/qemu\/(\d+)\/agent\/(.+)$/.exec(path))) {
    const vmid = Number(m[1]);
    const g = s.guests.find((x) => x.vmid === vmid);
    if (!g?.agent || g.status !== 'running') return { isError: 'PVE API 500: QEMU guest agent is not running' };
    if (m[2] === 'get-osinfo') return { json: { result: { name: 'Example', 'pretty-name': 'Example OS 1.0', id: 'example', machine: 'x86_64', 'kernel-release': '1.0' } } };
    return { json: { result: [{ name: 'lo', 'hardware-address': '00:00:00:00:00:00', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }] }, { name: 'eth0', 'hardware-address': '02:00:00:00:00:01', 'ip-addresses': [{ 'ip-address': '192.0.2.50', 'ip-address-type': 'ipv4', prefix: 24 }, { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6', prefix: 64 }] }] } };
  }
  // Field names as PVE sends them, extra ones included: relief must keep only what it names.
  if (path.endsWith('/rrddata')) {
    const guest = /\/(qemu|lxc)\//.test(path);
    return { json: Array.from({ length: 70 }, (_, i) => ({ time: 1790000000 + i * 60, cpu: 0.01 + i / 1000, maxcpu: 4, netin: 1000 + i, netout: 500, pressurecpusome: 0, ...(guest ? { mem: 2 ** 31, maxmem: 2 ** 32, disk: 0, maxdisk: 2 ** 35, diskread: 7 } : { memused: 2 ** 32, memtotal: 2 ** 34, rootused: 2 ** 32, roottotal: 2 ** 36, loadavg: 0.1 }) })) };
  }
  return { isError: `PVE API 404: no such path` };
}

function answer(s: MockState, name: string, args: Record<string, unknown>): Answer {
  if (s.all) return s.all;
  const key = name === 'proxmox_api_get' ? String(args.path) : name;
  const over = s.over.get(key);
  if (over) return over;
  switch (name) {
    case 'proxmox_list_resources': return { json: resources(s) };
    case 'proxmox_recent_tasks': return { json: s.tasks };
    case 'proxmox_guest_config': return { json: { name: 'guest-a', cores: 2, memory: '2048', ostype: 'l26', agent: '1', net0: 'virtio=02:00:00:00:00:01,bridge=vmbr0,firewall=1', scsi0: 'local-lvm:vm-100-disk-0,size=32G', ide2: 'none,media=cdrom', cipassword: 'mock-ci-password', sshkeys: 'ssh-ed25519%20mock-ssh-key', description: 'mock-description-text', hookscript: 'local:snippets/mock-hook.sh' } };
    case 'proxmox_api_get': return apiGet(s, String(args.path));
    default: return { isError: `mock does not implement ${name}` };
  }
}

export type Mock = { state: MockState; calls: { name: string; args: Record<string, unknown> }[]; port: number; url: string; tokens: Set<string>; requests: { value: number }; close(): Promise<void> };

export async function startMock(o: { port?: number; token: string }): Promise<Mock> {
  const state = freshState();
  const calls: Mock['calls'] = [];
  const requests = { value: 0 };
  const tokens = new Set([o.token]);
  const createServer = () => {
    const server = new Server({ name: 'mock-tower', version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler('tools/list', async () => ({ tools: state.tools }) as never);
    server.setRequestHandler('tools/call', async ({ params }) => {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: params.name, args });
      const a = answer(state, params.name, args);
      if ('protocol' in a) throw new ProtocolError(ProtocolErrorCode.InvalidParams, a.protocol);
      if ('isError' in a) return { isError: true, content: [{ type: 'text', text: a.isError }] } as never;
      return { content: [{ type: 'text', text: 'text' in a ? a.text : JSON.stringify(a.json, null, 2) }] } as never;
    });
    return server;
  };
  const handler = createMcpHandler(createServer);
  const app = new Hono();
  app.use('/mcp', async (c, next) => {
    requests.value += 1;
    if (state.hang) await new Promise(() => {});
    if (state.http) return c.text('mock', state.http as 503);
    const h = c.req.header('authorization') ?? '';
    if (!h.startsWith('Bearer ') || !tokens.has(h.slice(7))) return c.text('unauthorized', 401);
    return next();
  });
  app.all('/mcp', (c) => handler.fetch(c.req.raw));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: o.port ?? MOCK_PORT, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    state, calls, port, url: `http://127.0.0.1:${port}/mcp`, tokens, requests,
    close: () => new Promise<void>((r) => { server.close(() => r()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }),
  };
}
