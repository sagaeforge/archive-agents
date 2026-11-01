// No-fake rule (design 1 criterion 3, 12): an entity may only claim a source that is configured and readable. Also the two derivation rules (design 4).
import type { Snapshot } from './fact.ts';

export type Wire = { node: string; iface: string; cidr: string | null; gateway: string | null };

const v4 = (a: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0]! * 2 ** 24) + (p[1]! << 16) + (p[2]! << 8) + p[3]!);
};
const dotted = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** The network of an IPv4 CIDR, or null for anything else. */
export function networkOf(cidr: string): string | null {
  const [a, b] = cidr.split('/');
  const n = a ? v4(a) : null; const bits = Number(b);
  if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  return `${dotted(Math.floor(n / size) * size)}/${bits}`;
}

export const inNetwork = (addr: string, net: string): boolean => { const a = v4(addr); return a !== null && networkOf(`${addr}/${net.split('/')[1]}`) === net; };

/** Rule `same-subnet`: bridges with an address in one network form a segment. No input, no output. */
export function sameSubnet(wires: Wire[]): Map<string, Wire[]> {
  const out = new Map<string, Wire[]>();
  for (const w of wires) { const net = w.cidr ? networkOf(w.cidr) : null; if (net) (out.get(net) ?? out.set(net, []).get(net)!).push(w); }
  return out;
}

/** Rule `same-default-gateway`: the address nodes name as their gateway. What the device is stays unknown. */
export function sameDefaultGateway(wires: Wire[]): Map<string, Wire[]> {
  const out = new Map<string, Wire[]>();
  for (const w of wires) if (w.gateway) (out.get(w.gateway) ?? out.set(w.gateway, []).get(w.gateway)!).push(w);
  return out;
}

/** Which source status backs which `source` prefix. Rules are backed by the entities they read, checked below. */
const BACKING: [RegExp, string][] = [
  [/^pve:/, 'pve'],
  [/^edge\.json/, 'edge'],
  [/^docker:/, 'docker'],
];

/** @returns problems; empty means no entity stands on a missing source. */
export function checkNoFake(s: Snapshot): string[] {
  const bad: string[] = [];
  const state = new Map(s.sources.map((x) => [x.id, x.state]));
  const ids = new Set(s.nodes.map((n) => n.id));
  for (const n of s.nodes) {
    for (const [k, f] of Object.entries(n.facts)) {
      if (f.basis === 'unknown') continue; // an honest blank needs no source
      const hit = BACKING.find(([re]) => re.test(f.source));
      if (hit) {
        const st = state.get(hit[1]);
        if (st !== 'ok' && st !== 'failing') bad.push(`${n.id}.${k}: source ${hit[1]} is ${st ?? 'absent'}`);
      } else if (f.source.startsWith('rule:')) {
        // A derived entity needs the observations the rule reads. Today both rules read nodes.
        if (!s.nodes.some((m) => m.kind === 'node' && m.basis === 'observed')) bad.push(`${n.id}.${k}: rule without input`);
      } else bad.push(`${n.id}.${k}: unknown source ${f.source}`);
    }
    if (n.basis === 'observed' && !Object.values(n.facts).some((f) => f.basis === 'observed')) bad.push(`${n.id}: observed without an observed fact`);
    if (n.parent && !ids.has(n.parent)) bad.push(`${n.id}: orphan`);
  }
  // A source with status none cannot have entities of its layer.
  if (state.get('docker') !== 'ok' && s.nodes.some((n) => n.kind === 'container')) bad.push('container without docker source');
  if (state.get('pve') === 'none' && s.nodes.some((n) => ['node', 'vm', 'lxc', 'bridge', 'storage'].includes(n.kind))) bad.push('pve entity without pve source');
  if (state.get('edge') !== 'ok' && s.nodes.some((n) => n.basis === 'declared')) bad.push('declared entity without edge source');
  return bad;
}
