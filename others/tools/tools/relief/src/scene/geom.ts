import type { Pt, Rect } from './project.ts';

export const bboxOf = (polys: Pt[][]): Rect => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export const rectsHit = (a: Rect, b: Rect, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

export const inPolygon = (p: Pt, poly: Pt[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const orient = (p: Pt, q: Pt, t: Pt) => Math.sign((q[0] - p[0]) * (t[1] - p[1]) - (q[1] - p[1]) * (t[0] - p[0]));
const cross = (a: Pt, b: Pt, c: Pt, d: Pt) => orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);

/** Does the rectangle touch the polygon's drawn area? Edge crossings, a vertex inside, or the rectangle inside. */
export function rectHitsPoly(r: Rect, poly: Pt[]): boolean {
  const e = 0.5; // the same inset the screen test uses, so a graze is not a cover
  const x0 = r.x + e, y0 = r.y + e, x1 = r.x + r.w - e, y1 = r.y + r.h - e;
  if (poly.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) return true;
  const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (corners.some((c) => inPolygon(c, poly))) return true;
  for (let i = 0; i < poly.length; i++) for (let j = 0; j < 4; j++) if (cross(poly[i]!, poly[(i + 1) % poly.length]!, corners[j]!, corners[(j + 1) % 4]!)) return true;
  return false;
}
