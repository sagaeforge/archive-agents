// Projection and paint order (design 9.1). The floor is the plane z = 0; a block rises by its z.
export type Mode = 'iso' | '2d';
export type Pt = [number, number];

const C = Math.cos(Math.PI / 6);

/** iso: screen x = (x - y) cos30, screen y = (x + y) sin30 - z. 2d: the floor as it is. */
export const project = (mode: Mode, S: number) => (mode === 'iso'
  ? (x: number, y: number, z = 0): Pt => [(x - y) * C * S, (x + y) * 0.5 * S - z * S]
  : (x: number, y: number, _z = 0): Pt => [x * S, y * S]);

export const pts = (a: Pt[]) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export type Rect = { x: number; y: number; w: number; h: number };

/** Axis-aligned boxes: `a` is drawn before `b` when it lies behind `b` on one axis and overlaps it on the other. Siblings never overlap. */
export function paintOrder<T extends Rect>(list: T[]): T[] {
  const before = (a: Rect, b: Rect) => (a.x + a.w <= b.x && a.y < b.y + b.h && b.y < a.y + a.h) || (a.y + a.h <= b.y && a.x < b.x + b.w && b.x < a.x + a.w);
  const rest = [...list]; const done: T[] = [];
  while (rest.length) {
    let i = rest.findIndex((a) => !rest.some((b) => b !== a && before(b, a)));
    if (i < 0) i = 0; // a cycle cannot happen for disjoint boxes; take the first rather than loop
    done.push(rest.splice(i, 1)[0]!);
  }
  return done;
}

const hex = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
const out = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export const shade = (h: string, f: number) => out(hex(h, 1) * f, hex(h, 3) * f, hex(h, 5) * f);
export const tint = (h: string, f: number) => out(...([1, 3, 5].map((i) => hex(h, i) + (255 - hex(h, i)) * f) as [number, number, number]));
