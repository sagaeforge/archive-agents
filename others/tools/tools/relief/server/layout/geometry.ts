// Floor sizes and block heights per kind, in layout units (design 9.1, 10). Ported from the S6 spike.
import type { Kind } from '../model/fact.ts';

export const SIZE: Record<Kind, [number, number]> = {
  wan: [60, 60], modem: [52, 52], domain: [56, 56], gateway: [64, 64], tunnel: [60, 60], proxy: [60, 60], switch: [56, 56], wifi: [52, 52], clients: [52, 52],
  segment: [44, 150], node: [0, 0], workstation: [96, 80], bmc: [20, 20], bridge: [30, 30], storage: [30, 30], vm: [52, 52], lxc: [38, 38], container: [20, 20],
};
export const HEIGHT: Record<Kind | 'dockerhost', number> = {
  wan: 46, modem: 34, domain: 44, gateway: 42, tunnel: 34, proxy: 38, switch: 26, wifi: 48, clients: 30, segment: 8, node: 18, workstation: 10,
  bmc: 8, bridge: 6, storage: 21, vm: 32, lxc: 22, container: 12, dockerhost: 8,
};
/** Bridges and storage hold a column on the slab's west edge, where uplinks arrive. */
export const INFRA: ReadonlySet<Kind> = new Set<Kind>(['bridge', 'storage']);
/** Strip along the slab's north edge reserved for its label, so the label point always lies on its own top face (design 17, item 9). */
export const HEADER = 26;
export const quant = (v: number, q: number) => Math.ceil(v / q) * q;
