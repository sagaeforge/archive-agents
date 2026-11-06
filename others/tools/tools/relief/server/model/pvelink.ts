// "PVE 열기" (relief-v2 4): a link straight to the node. No proxy, no credential, no input: the URL is built from the address relief observed and nothing else.
import { validId, validNode } from '../collect/allowlist.ts';
import type { Entity } from './fact.ts';
import { inNetwork, LAN_NETS } from './rules.ts';
import { isDottedV4 } from './ssh.ts';

export const PVE_PORT = 8006;
export type PveOffer = { url: string } | { why: string };

/** A canonical private address that relief read from Proxmox itself. Declared and guest-reported values cannot get here. */
const nodeAddress = (n: Entity): string | null => {
  const f = n.facts.address;
  if (f?.basis !== 'observed' || !f.source.startsWith('pve:') || typeof f.value !== 'string') return null;
  const [a, prefix, ...rest] = f.value.split('/') as [string, string?, ...string[]];
  if (rest.length > 0 || (prefix !== undefined && !/^\d{1,2}$/.test(prefix))) return null;
  return isDottedV4(a) && LAN_NETS.some((net) => inNetwork(a, net)) ? a : null;
};

/** @returns the link for a node or a guest, why there is none, or null for an object PVE does not show. */
export function pveLink(e: Entity, nodes: readonly Entity[]): PveOffer | null {
  if (e.kind !== 'node' && e.kind !== 'vm' && e.kind !== 'lxc') return null;
  const node = e.kind === 'node' ? e : nodes.find((n) => n.id === e.parent);
  if (!node) return { why: '노드를 모른다' };
  const name = node.id.split(':')[2];
  const addr = nodeAddress(node);
  if (addr === null || !validNode(name)) return { why: '노드 주소를 관측하지 못했다' };
  const base = `https://${addr}:${PVE_PORT}/`;
  if (e.kind === 'node') return { url: `${base}#v1:0:=node%2F${encodeURIComponent(name)}` };
  const vmid = Number(e.id.split(':')[2]);
  if (!validId(vmid)) return { why: '게스트 번호가 규칙에 맞지 않는다' };
  return { url: `${base}#v1:0:=${e.kind === 'vm' ? 'qemu' : 'lxc'}%2F${vmid}` };
}
