// `relief status` and `relief check` (design 11). Output names templates, never a real name or address, and never the token.
import { existsSync } from 'node:fs';
import { PATHS, TOOLS, type Target } from './collect/allowlist.ts';
import { createReader, ReadError } from './collect/mcp.ts';
import { DEFAULT_PORT, loadConfig, readToken, resolvePaths } from './config.ts';
import type { LiveStatus } from './live.ts';

type Print = (line: string) => void;
export type CliOptions = { env?: NodeJS.ProcessEnv; print?: Print };

export async function status(o: CliOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const print = o.print ?? console.log;
  const port = Number(env.RELIEF_PORT ?? DEFAULT_PORT);
  let s: LiveStatus;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
    s = (await r.json()) as LiveStatus;
  } catch {
    print(`relief: not running on 127.0.0.1:${port}`);
    return 1;
  }
  print(`seq ${s.seq}`);
  for (const x of s.sources) print(`${x.id}: ${x.state}${x.count === null ? '' : ` ${x.count}개`}${x.at ? ` · 마지막 성공 ${x.at}` : ''}${x.why ? ` · ${x.why}` : ''}`);
  print(`calls ${s.calls.total} · refused ${s.calls.refused}`);
  for (const [k, v] of Object.entries(s.calls.byLabel).sort()) print(`  ${v} ${k}`);
  return 0;
}

type Row = { tool: string; template: string; target?: Target; soft?: boolean };

/** One target per tool and path template. A template with no subject today is reported, not faked. */
function plan(node: string | undefined, guests: { kind: 'qemu' | 'lxc'; vmid: number; node: string; running: boolean }[]): Row[] {
  const api = (template: string, path: string | null, params?: Record<string, string>, soft = false): Row =>
    (path === null ? { tool: 'proxmox_api_get', template } : { tool: 'proxmox_api_get', template, target: { tool: 'proxmox_api_get', path, ...(params ? { params } : {}) }, soft });
  const qemu = guests.find((g) => g.kind === 'qemu');
  const running = guests.find((g) => g.kind === 'qemu' && g.running);
  const lxc = guests.find((g) => g.kind === 'lxc');
  const n = (t: string) => (node ? t.replace('{n}', node) : null);
  const hour = { timeframe: 'hour' };
  const agent = (leaf: string) => (running ? `/nodes/${running.node}/qemu/${running.vmid}/agent/${leaf}` : null);
  const paths: Record<(typeof PATHS)[number], Row[]> = {
    '/cluster/status': [api('/cluster/status', '/cluster/status')],
    '/cluster/metrics/export': [api('/cluster/metrics/export', '/cluster/metrics/export')],
    '/cluster/sdn/zones': [api('/cluster/sdn/zones', '/cluster/sdn/zones')],
    '/cluster/sdn/vnets': [api('/cluster/sdn/vnets', '/cluster/sdn/vnets')],
    '/cluster/firewall/rules': [api('/cluster/firewall/rules', '/cluster/firewall/rules')],
    '/nodes/{n}/network': [api('/nodes/{n}/network', n('/nodes/{n}/network'))],
    '/nodes/{n}/dns': [api('/nodes/{n}/dns', n('/nodes/{n}/dns'))],
    '/nodes/{n}/firewall/rules': [api('/nodes/{n}/firewall/rules', n('/nodes/{n}/firewall/rules'))],
    // A guest without a running agent answers 500. That is a value relief shows as unknown, not a broken read.
    '/nodes/{n}/qemu/{id}/agent/network-get-interfaces': [api('/nodes/{n}/qemu/{id}/agent/network-get-interfaces', agent('network-get-interfaces'), undefined, true)],
    '/nodes/{n}/qemu/{id}/agent/get-osinfo': [api('/nodes/{n}/qemu/{id}/agent/get-osinfo', agent('get-osinfo'), undefined, true)],
    '/nodes/{n}/rrddata': [api('/nodes/{n}/rrddata', n('/nodes/{n}/rrddata'), hour)],
    '/nodes/{n}/{qemu|lxc}/{id}/rrddata': [
      api('/nodes/{n}/qemu/{id}/rrddata', qemu ? `/nodes/${qemu.node}/qemu/${qemu.vmid}/rrddata` : null, hour),
      api('/nodes/{n}/lxc/{id}/rrddata', lxc ? `/nodes/${lxc.node}/lxc/${lxc.vmid}/rrddata` : null, hour),
    ],
  };
  const guest = qemu ?? lxc;
  return [
    { tool: 'proxmox_list_resources', template: '/cluster/resources', target: { tool: 'proxmox_list_resources' } },
    { tool: 'proxmox_recent_tasks', template: '/cluster/tasks', target: { tool: 'proxmox_recent_tasks' } },
    guest ? { tool: 'proxmox_guest_config', template: '/nodes/{n}/{qemu|lxc}/{id}/config', target: { tool: 'proxmox_guest_config', node: guest.node, vmid: guest.vmid, kind: guest.kind } } : { tool: 'proxmox_guest_config', template: '/nodes/{n}/{qemu|lxc}/{id}/config' },
    ...Object.values(paths).flat(),
  ];
}

export async function check(o: CliOptions & { live?: boolean } = {}): Promise<number> {
  const env = o.env ?? process.env;
  const print = o.print ?? console.log;
  const paths = resolvePaths(env);
  const cfg = loadConfig(paths);
  let code = 0;
  print(`relief.json: ${cfg.error ?? (existsSync(paths.reliefJson) ? 'ok' : 'none, defaults')}`);
  if (cfg.error) code = 1;
  const token = () => readToken(paths.tokenFile);
  print(`tower token: ${token() ? 'readable' : 'missing'}`);
  print('edge.json: not read before Phase 3');
  if (!o.live || cfg.error) return code; // A file that failed its check names no tower to trust, so the token goes nowhere.
  if (!token()) return 1;

  const reader = createReader({ url: cfg.towerUrl, token });
  try {
    let list: { type?: string; node?: string; vmid?: number; status?: string }[];
    try {
      list = (await reader.read({ tool: 'proxmox_list_resources' })) as typeof list;
    } catch (e) {
      print(`tower: ${e instanceof ReadError ? e.why : 'read failed'}`);
      return 1;
    }
    print(`tools: ${TOOLS.length} present and read-only`);
    const node = list.find((r) => r.type === 'node' && r.status === 'online')?.node;
    const guests = list.flatMap((r) => ((r.type === 'qemu' || r.type === 'lxc') && r.node && r.vmid ? [{ kind: r.type as 'qemu' | 'lxc', vmid: r.vmid, node: r.node, running: r.status === 'running' }] : []));
    for (const row of plan(node, guests)) {
      if (!row.target) { print(`skip ${row.tool} ${row.template}: nothing to read today`); continue; }
      const t0 = performance.now();
      try {
        const v = await reader.read(row.target);
        print(`ok   ${row.tool} ${row.template} ${Buffer.byteLength(JSON.stringify(v, null, 2))} B ${Math.round(performance.now() - t0)} ms`);
      } catch (e) {
        const why = e instanceof ReadError ? e.why : 'read failed';
        print(`${row.soft ? 'warn' : 'FAIL'} ${row.tool} ${row.template}: ${why}`);
        if (!row.soft) code = 1;
      }
    }
    const r = reader.record;
    print(`calls ${r.total} · refused ${r.refused} · all through the allowlist`);
    for (const [k, v] of Object.entries(r.byLabel).sort()) print(`  ${v} ${k}`);
    return code;
  } finally {
    await reader.close();
  }
}
