// Run in the page: geometry truth from the browser (real glyph widths), not from the estimate the layout step used.
export type Audit = {
  labels: number; overlaps: string[][]; clipped: string[]; overflow: string[]; orphans: string[]; far: [string, number][]; offFace: string[];
  objects: number; noBasis: number; noAria: number; elements: number; panelOverflow: boolean; errors: string[];
};

export const audit = (): Omit<Audit, 'errors'> => {
  const svg = document.querySelector('svg.scene')!; const box = svg.getBoundingClientRect();
  const lbs = [...document.querySelectorAll('.lb')].map((g) => ({ id: (g as SVGGElement).dataset.for!, g: g as SVGGElement, r: g.querySelector('rect')!.getBoundingClientRect(), t: g.querySelector('text')!.getBoundingClientRect() }));
  const overlaps: string[][] = [];
  for (let i = 0; i < lbs.length; i++) for (let j = i + 1; j < lbs.length; j++) {
    const a = lbs[i]!.r; const b = lbs[j]!.r;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push([lbs[i]!.id, lbs[j]!.id]);
  }
  const clipped = lbs.filter((l) => l.r.left < box.left || l.r.right > box.right || l.r.top < box.top || l.r.bottom > box.bottom).map((l) => l.id);
  const overflow = lbs.filter((l) => l.t.width > l.r.width - 2).map((l) => l.id);
  const objects = [...document.querySelectorAll('svg.scene [data-id]')] as SVGElement[];
  const ids = new Set(objects.map((o) => o.dataset.id!));
  const orphans = lbs.filter((l) => !ids.has(l.id)).map((l) => l.id);
  const far: [string, number][] = [];
  for (const l of lbs) {
    const o = document.querySelector(`svg.scene [data-id="${CSS.escape(l.id)}"]`); if (!o) continue;
    const r = o.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - l.r.right, 0, l.r.left - r.right), Math.max(r.top - l.r.bottom, 0, l.r.top - r.bottom));
    if (d > 24) far.push([l.id, Math.round(d)]);
  }
  // A node label's anchor must lie inside that node's own top face (design 17, item 9).
  const offFace: string[] = [];
  for (const l of lbs) {
    const o = document.querySelector(`svg.scene [data-id="${CSS.escape(l.id)}"][data-kind="node"]`); if (!o) continue;
    if (l.g.querySelector('.lead')) continue; // beside the slab with a leader line to it
    const top = o.querySelector('[data-face="top"]')!.getAttribute('points')!.trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]);
    const x = Number(l.g.dataset.ax); const y = Number(l.g.dataset.ay);
    let inside = false;
    for (let i = 0, j = top.length - 1; i < top.length; j = i++) { const [xi, yi] = top[i]!; const [xj, yj] = top[j]!; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; }
    if (!inside) offFace.push(l.id);
  }
  const aside = document.querySelector('aside .body')!;
  return {
    labels: lbs.length, overlaps, clipped, overflow, orphans, far, offFace, objects: objects.length,
    noBasis: objects.filter((o) => !o.dataset.basis).length,
    noAria: objects.filter((o) => o.tagName === 'g' && !o.getAttribute('aria-label')).length,
    elements: document.querySelectorAll('svg.scene *').length,
    panelOverflow: aside.scrollWidth > aside.clientWidth + 1,
  };
};
