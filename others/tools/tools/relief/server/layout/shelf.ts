// Slab interiors by shelf slots (design 10): first-seen order gets the next slot, sizes round up to 80, so adding a guest moves nobody.
import type { Entity } from '../model/fact.ts';
import { HEADER, HEIGHT, INFRA, quant, SIZE } from './geometry.ts';

export type Slot = { id: string; x: number; y: number; w: number; h: number; zh: number; children?: Slot[] };

/** A guest that runs containers is a low pad with a fixed 4x4 grid, 5x5 above 16, so the pad keeps its size while containers come and go. */
function shelfHost(g: Entity, kids: Entity[]): Slot {
  const cols = kids.length <= 16 ? 4 : 5;
  const pad = 8; const gap = 6; const cell = SIZE.container[0];
  const side = cols * cell + (cols - 1) * gap + 2 * pad;
  return {
    id: g.id, x: 0, y: 0, w: side, h: side, zh: HEIGHT.dockerhost,
    children: kids.map((c, i) => ({ id: c.id, x: pad + (i % cols) * (cell + gap), y: pad + Math.floor(i / cols) * (cell + gap), w: cell, h: cell, zh: HEIGHT.container })),
  };
}

/** Width of every slab: a step function of the biggest node, so it changes rarely. */
export function slabWidth(nodes: Entity[], childrenOf: (id: string) => Entity[]): number {
  const areas = nodes.filter((n) => n.kind === 'node').map((n) => childrenOf(n.id).reduce((s, c) => s + (childrenOf(c.id).length ? 114 ** 2 : SIZE[c.kind][0] ** 2 * 1.5), 0));
  return Math.max(240, quant(Math.sqrt(Math.max(0, ...areas) * 1.6), 80));
}

export function shelfNode(n: Entity, childrenOf: (id: string) => Entity[], W: number): { w: number; h: number; children: Slot[]; ports: { id: string; y: number }[] } {
  const pad = 14; const gap = 10;
  const kids = childrenOf(n.id);
  const out: Slot[] = []; const ports: { id: string; y: number }[] = [];
  let colY = pad + HEADER;
  for (const c of kids.filter((k) => INFRA.has(k.kind))) {
    const [w, h] = SIZE[c.kind];
    out.push({ id: c.id, x: pad, y: colY, w, h, zh: HEIGHT[c.kind] });
    if (c.kind === 'bridge') ports.push({ id: c.id, y: colY + h / 2 });
    colY += h + gap;
  }
  const left = pad + SIZE.bridge[0] + 2 * gap;
  let x = left; let y = pad + HEADER; let rowH = 0;
  for (const c of kids.filter((k) => !INFRA.has(k.kind))) {
    const sub = childrenOf(c.id);
    const item: Slot = sub.length ? shelfHost(c, sub) : { id: c.id, x: 0, y: 0, w: SIZE[c.kind][0], h: SIZE[c.kind][1], zh: HEIGHT[c.kind] };
    if (x + item.w > W - pad) { x = left; y += rowH + gap; rowH = 0; }
    out.push({ ...item, x, y }); x += item.w + gap; rowH = Math.max(rowH, item.h);
  }
  return { w: W, h: quant(Math.max(colY - gap, y + rowH) + pad, 80), children: out, ports };
}
