// What relief may read through tower (design 6.3). tower does not block write tools, so this file does: exact names, exact path templates, no way to widen them.
export const TOOLS = ['proxmox_list_resources', 'proxmox_recent_tasks', 'proxmox_guest_config', 'proxmox_api_get'] as const;
export type Tool = (typeof TOOLS)[number];

export const TASK_LIMIT = 50;

/** `{n}` is a node name, `{id}` a positive integer, `{qemu|lxc}` one of the two. rrddata takes timeframe=hour and nothing else. */
export const PATHS = [
  '/cluster/status', '/cluster/metrics/export',
  '/cluster/sdn/zones', '/cluster/sdn/vnets', '/cluster/firewall/rules',
  '/nodes/{n}/network', '/nodes/{n}/dns', '/nodes/{n}/firewall/rules',
  '/nodes/{n}/qemu/{id}/agent/network-get-interfaces', '/nodes/{n}/qemu/{id}/agent/get-osinfo',
  '/nodes/{n}/rrddata', '/nodes/{n}/{qemu|lxc}/{id}/rrddata',
] as const;

export type Target =
  | { tool: 'proxmox_list_resources' }
  | { tool: 'proxmox_recent_tasks' }
  | { tool: 'proxmox_guest_config'; node: string; vmid: number; kind: 'qemu' | 'lxc' }
  | { tool: 'proxmox_api_get'; path: string; params?: Record<string, string> };

export class NotAllowed extends Error {
  constructor(what: string) { super(`not on the allowlist: ${what.slice(0, 120)}`); this.name = 'NotAllowed'; }
}

/** The plugin's node pattern [tools.mjs:5], minus `.` and `..`, which that pattern lets through and which walk the path. */
const NAME = /^(?!\.{1,2}$)[\w.-]+$/;
export const validNode = (n: unknown): n is string => typeof n === 'string' && NAME.test(n);
export const validId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const compile = (t: string) => new RegExp(`^${t
  .replace('{n}', '(?!\\.{1,2}/)[\\w.-]+')
  .replace('{id}', '[1-9][0-9]{0,14}')
  .replace('{qemu|lxc}', '(?:qemu|lxc)')}$`);
const COMPILED = PATHS.map((t) => ({ t, re: compile(t), rrd: t.endsWith('/rrddata') }));

const isTool = (v: unknown): v is Tool => (TOOLS as readonly unknown[]).includes(v);

export type Call = { name: Tool; args: Record<string, unknown>; label: string };

/** Turns a target into the one call it may become, or throws before anything reaches the network. */
export function callOf(t: Target): Call {
  if (!isTool((t as { tool?: unknown } | null)?.tool)) throw new NotAllowed(`tool ${String((t as { tool?: unknown } | null)?.tool)}`);
  switch (t.tool) {
    case 'proxmox_list_resources': return { name: t.tool, args: {}, label: t.tool };
    case 'proxmox_recent_tasks': return { name: t.tool, args: { limit: TASK_LIMIT }, label: t.tool };
    case 'proxmox_guest_config':
      if (!validNode(t.node) || !validId(t.vmid) || (t.kind !== 'qemu' && t.kind !== 'lxc')) throw new NotAllowed('guest_config arguments');
      return { name: t.tool, args: { node: t.node, vmid: t.vmid, kind: t.kind }, label: t.tool };
    case 'proxmox_api_get': {
      const hit = typeof t.path === 'string' ? COMPILED.find((c) => c.re.test(t.path)) : undefined;
      if (!hit) throw new NotAllowed(`path ${String(t.path)}`);
      const keys = Object.keys(t.params ?? {});
      const hourOnly = keys.length === 1 && t.params?.timeframe === 'hour';
      if (hit.rrd ? !hourOnly : keys.length > 0) throw new NotAllowed(`params of ${hit.t}`);
      return { name: t.tool, args: { path: t.path, ...(keys.length ? { params: { timeframe: 'hour' } } : {}) }, label: `${t.tool} ${hit.t}` };
    }
  }
}
