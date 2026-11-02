// The miniature (design 9.10): one isometric form per kind, built from prisms and cylinders in the object's own floor units.
// Light comes from the upper left: tops brightest, left faces middle, right faces dark. Every shade is a token, so a theme changes all of it at once.
// A form stays inside its layout box, so the paint order of boxes holds for it. Lines that carry no shape share one <path> per object: the 500-object budget counts elements.
import type { Box, Kind } from '../../server/model/fact.ts';
import { HEADER } from '../../server/layout/geometry.ts';
import type { Pt } from './project.ts';
import type { Tone } from './style.ts';

export type Part = { face: 'top' | 'left' | 'right'; tone: Tone; pts: Pt[]; material?: string; main?: boolean };
export type Form = { parts: Part[]; detail: string };
type Project = (x: number, y: number, z?: number) => Pt;
type P3 = [number, number, number];

/** How far a form rises above its box: the rack on a node, the tower on a PC. The fit of the view counts it. */
export const RISE: Partial<Record<Kind, number>> = { node: 50, workstation: 42 };

const fmt = (p: Pt) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

class Build {
  parts: Part[] = []; d: string[] = [];
  private P: Project; private b: Box;
  constructor(P: Project, b: Box) { this.P = P; this.b = b; }
  at(x: number, y: number, z: number): Pt { return this.P(this.b.x + x, this.b.y + y, this.b.z + z); }
  private push(face: Part['face'], tone: Tone, pts: Pt[], o: Opt) { this.parts.push({ face, tone, pts, ...(o.material ? { material: o.material } : {}), ...(o.main ? { main: true } : {}) }); }
  /** Left is the y1 face, right the x1 face. Both face the viewer. */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, o: Opt = {}) {
    this.push('left', 'l', [this.at(x0, y1, z1), this.at(x1, y1, z1), this.at(x1, y1, z0), this.at(x0, y1, z0)], o);
    this.push('right', 'r', [this.at(x1, y0, z1), this.at(x1, y1, z1), this.at(x1, y1, z0), this.at(x1, y0, z0)], o);
    if (!o.open) this.push('top', 't', [this.at(x0, y0, z1), this.at(x1, y0, z1), this.at(x1, y1, z1), this.at(x0, y1, z1)], o);
  }
  /** A thin post: two faces, no top worth a polygon. */
  post(x: number, y: number, r: number, z0: number, z1: number, o: Opt = {}) { this.box(x - r, y - r, x + r, y + r, z0, z1, { ...o, open: true }); }
  /** A cylinder. Seen from this angle its side turns at -45 and 135 degrees: each half takes the tone of the face it stands in for. */
  cyl(cx: number, cy: number, r: number, z0: number, z1: number, o: Opt = {}) {
    const ring = (from: number, to: number, z: number): Pt[] => { const out: Pt[] = []; for (let a = from; a <= to + 0.1; a += 15) { const t = (a * Math.PI) / 180; out.push(this.at(cx + r * Math.cos(t), cy + r * Math.sin(t), z)); } return out; };
    this.push('right', 'r', [...ring(-45, 45, z1), ...ring(-45, 45, z0).reverse()], o);
    this.push('left', 'l', [...ring(45, 135, z1), ...ring(45, 135, z0).reverse()], o);
    this.push('top', 't', ring(0, 345, z1), o);
  }
  /** A prism of any floor outline, listed clockwise from above, with `from..to` the corners that face the viewer. */
  poly(outline: [number, number][], turnLeft: number, z0: number, z1: number, o: Opt = {}) {
    const n = outline.length; const r: Pt[] = []; const l: Pt[] = [];
    const up = (p: [number, number], z: number) => this.at(p[0], p[1], z);
    for (let i = 0; i <= turnLeft; i++) r.push(up(outline[i]!, z1));
    for (let i = turnLeft; i >= 0; i--) r.push(up(outline[i]!, z0));
    for (let i = turnLeft; i < n; i++) l.push(up(outline[i]!, z1));
    for (let i = n - 1; i >= turnLeft; i--) l.push(up(outline[i]!, z0));
    this.push('right', 'r', r, o); this.push('left', 'l', l, o);
    this.push('top', 't', outline.map((p) => up(p, z1)), o);
  }
  raw(face: Part['face'], tone: Tone, pts: Pt[], o: Opt = {}) { this.push(face, tone, pts, o); }
  /** Lines in object space. They wear the detail token. */
  line(...pts: P3[]) { this.d.push(`M${pts.map((p) => fmt(this.at(p[0], p[1], p[2]))).join('L')}`); }
  /** n lines across a left face (y fixed), bottom to top. */
  unitsLeft(x0: number, x1: number, y: number, z0: number, z1: number, n: number) { for (let i = 1; i <= n; i++) { const z = z0 + ((z1 - z0) * i) / (n + 1); this.line([x0, y, z], [x1, y, z]); } }
  unitsRight(y0: number, y1: number, x: number, z0: number, z1: number, n: number) { for (let i = 1; i <= n; i++) { const z = z0 + ((z1 - z0) * i) / (n + 1); this.line([x, y0, z], [x, y1, z]); } }
  /** A row of short upright ticks on a left face: ports, LEDs. */
  ticksLeft(x0: number, x1: number, y: number, z: number, n: number, tall = 1.6) { for (let i = 0; i < n; i++) { const x = x0 + ((x1 - x0) * (i + 0.5)) / n; this.line([x, y, z], [x, y, z + tall]); } }
  arc(cx: number, cy: number, z: number, r: number, from: number, to: number) {
    const pts: P3[] = []; for (let a = from; a <= to + 0.1; a += (to - from) / 6) { const t = (a * Math.PI) / 180; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t), z]); }
    this.line(...pts);
  }
  done(): Form { return { parts: this.parts, detail: this.d.join('') }; }
}
type Opt = { material?: string; main?: boolean; open?: boolean };

const DARK = { material: 'dark' }; const METAL = { material: 'metal' }; const SCREEN = { material: 'screen' };

/** The plate an outside device stands on. Its top is the object's main top, so basis stripes have room whatever stands on them. */
const pad = (f: Build, b: Box) => f.box(0, 0, b.w, b.h, 0, 3, { main: true });

const FORMS: Partial<Record<Kind | 'dockerhost', (f: Build, b: Box, S: number, dense: boolean) => void>> = {
  // A raised platform on a recessed skirt, with a rack cabinet on its north strip. Children stand on the platform.
  node(f, b) {
    const { w, h, zh } = b; const lip = 5;
    f.box(lip, lip, w - lip, h - lip, 0, 5, { ...DARK, open: true });
    f.box(0, 0, w, h, 5, zh, { main: true });
    f.unitsLeft(10, w - 10, h, 6, zh - 1, 2); f.unitsRight(10, h - 10, w, 6, zh - 1, 2);
    const x1 = w - 12; const x0 = x1 - 44; const y0 = 3; const y1 = HEADER - 3; const z0 = zh; const z1 = zh + 48;
    f.box(x0, y0, x1, y1, z0, z1, { material: 'rack' });
    f.unitsLeft(x0 + 3, x1 - 3, y1, z0 + 3, z1 - 3, 9);
    f.line([x0 + 3, y1, z0 + 3], [x0 + 3, y1, z1 - 3]); f.line([x1 - 3, y1, z0 + 3], [x1 - 3, y1, z1 - 3]);
    for (let i = 0; i < 4; i++) { const z = z0 + 8 + i * 10; f.line([x0 + 6, y1, z], [x0 + 12, y1, z]); }
    f.unitsRight(y0 + 2, y1 - 2, x1, z0 + 3, z1 - 3, 3);
  },
  // A desk mat with a tower, a monitor and a keyboard.
  workstation(f, b) {
    const { w, h, zh } = b; const lip = 3;
    f.box(lip, lip, w - lip, h - lip, 0, 3, { ...DARK, open: true });
    f.box(0, 0, w, h, 3, zh, { main: true });
    f.box(58, 30, 78, 70, zh, zh + 40, { material: 'rack' });
    f.unitsLeft(61, 75, 70, zh + 24, zh + 37, 2); f.line([61, 70, zh + 6], [75, 70, zh + 6]); f.ticksLeft(62, 74, 70, zh + 12, 3, 3);
    f.box(30, 42, 33, 47, zh, zh + 8, METAL);
    f.box(14, 42, 50, 45, zh + 8, zh + 34, DARK);
    f.raw('left', 'l', [f.at(16, 45, zh + 32), f.at(48, 45, zh + 32), f.at(48, 45, zh + 10), f.at(16, 45, zh + 10)], SCREEN);
    f.box(14, 52, 46, 66, zh, zh + 2, METAL);
  },
  storage(f, b, _S, dense) {
    const c = b.w / 2; const r = b.w / 2 - 1;
    if (dense) { f.cyl(c, c, r, 0, 21, { main: true }); for (const z of [7, 14]) f.arc(c, c, z, r, -45, 135); return; }
    f.cyl(c, c, r, 0, 6, { main: true }); f.cyl(c, c, r, 7.5, 13.5, { main: true }); f.cyl(c, c, r, 15, 21, { main: true });
    f.arc(c, c, 3, r, 0, 90); f.arc(c, c, 10.5, r, 0, 90); f.arc(c, c, 18, r, 0, 90);
  },
  bridge(f, b) {
    f.box(0, 0, b.w, b.h, 0, 3, { main: true });
    f.box(5, 8, b.w - 5, b.h - 8, 3, b.zh, DARK);
    f.ticksLeft(3, b.w - 3, b.h, 0.6, 5, 1.8); f.ticksLeft(7, b.w - 7, b.h - 8, 3.6, 4, 1.6);
  },
  bmc(f, b) { f.box(0, 0, b.w, b.h, 0, b.zh, { main: true }); f.ticksLeft(3, b.w - 3, b.h, 3, 2); },
  // A server: bezel, drive lines, a vented top.
  vm(f, b) {
    const { w, h, zh } = b;
    f.box(1, 1, w - 1, h - 1, 0, zh, { main: true });
    const y = h - 1;
    f.unitsLeft(5, w - 5, y, 4, zh - 3, 4); f.line([5, y, 4], [5, y, zh - 3]); f.line([w - 5, y, 4], [w - 5, y, zh - 3]);
    f.unitsRight(6, h - 6, w - 1, 4, zh - 4, 2);
    f.line([9, 9, zh], [w - 9, 9, zh], [w - 9, h - 9, zh], [9, h - 9, zh], [9, 9, zh]);
  },
  // A low pad for containers.
  dockerhost(f, b) {
    f.box(0, 0, b.w, b.h, 0, b.zh, { main: true });
    f.ticksLeft(6, b.w - 6, b.h, 2, 6, 3);
  },
  // Chamfered, so a system container never reads as a small VM.
  lxc(f, b) {
    const { w, h, zh } = b; const c = 9;
    f.poly([[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]], 4, 0, zh, { main: true });
    f.line([c + 5, 6, zh], [w - c - 5, 6, zh]); f.line([c + 5, h - 6, zh], [w - c - 5, h - 6, zh]);
    f.line([c, h, zh - 7], [w - c, h, zh - 7], [w, h - c, zh - 7], [w, c, zh - 7]);
  },
  // A shipping box: ribs on both visible sides.
  container(f, b) {
    const { w, h, zh } = b;
    f.box(0, 0, w, h, 0, zh, { main: true });
    for (const x of [5, 10, 15]) f.line([x, h, 2], [x, h, zh - 2]);
    for (const y of [5, 10, 15]) f.line([w, y, 2], [w, y, zh - 2]);
  },
  // A long bus on the floor with its taps.
  segment(f, b) {
    f.box(0, 0, b.w, b.h, 0, b.zh, { main: true });
    f.line([b.w / 2, 6, b.zh], [b.w / 2, b.h - 6, b.zh]);
    for (let y = 16; y < b.h - 8; y += 24) f.line([8, y, b.zh], [b.w - 8, y, b.zh]);
  },
  // A router: flat body, antennas, a row of lights.
  gateway(f, b) {
    pad(f, b);
    const { w, h } = b; const z = 16;
    f.box(8, 12, w - 8, h - 10, 3, z);
    for (const x of [14, w / 2, w - 14]) { f.post(x, 16, 1.6, z, 42, METAL); f.line([x - 1.4, 16 + 1.4, 34], [x + 1.4, 16 + 1.4, 34]); }
    f.ticksLeft(14, w - 14, h - 10, 7, 7, 3); f.unitsRight(16, h - 14, w - 8, 5, z - 3, 1);
  },
  // A modem stands on edge on a foot, lights down its face.
  modem(f, b) {
    pad(f, b);
    const { w, h } = b;
    f.box(12, h / 2 - 6, w - 12, h / 2 + 8, 3, 6, DARK);
    f.box(16, h / 2 - 3, w - 16, h / 2 + 5, 6, 34);
    for (let i = 0; i < 4; i++) { const z = 12 + i * 5; f.line([20, h / 2 + 5, z], [26, h / 2 + 5, z]); }
    f.unitsRight(h / 2 - 1, h / 2 + 3, w - 16, 8, 30, 3);
  },
  // A domain is no box in the room: a cloud on a post.
  domain(f, b, S) {
    pad(f, b);
    const { w, h } = b; const cx = w / 2; const cy = h / 2;
    f.post(cx, cy, 1.8, 3, 26, METAL);
    const cloud = (drop: number): Pt[] => {
      const c = f.at(cx, cy, 33); const out: Pt[] = [];
      for (let a = 0; a < 360; a += 12) {
        const t = (a * Math.PI) / 180;
        const bumps = 1 + 0.2 * Math.abs(Math.sin(t * 2.5 + 0.5));
        out.push([c[0] + Math.cos(t) * 22 * bumps * S, c[1] + drop * S + Math.sin(t) * 11 * Math.min(bumps, 1.08) * S]);
      }
      return out;
    };
    f.raw('right', 'r', cloud(5));
    f.raw('top', 't', cloud(0));
    const c = f.at(cx, cy, 33);
    f.d.push(`M${fmt([c[0] - 9 * S, c[1]])}L${fmt([c[0] + 9 * S, c[1]])}M${fmt([c[0] - 6 * S, c[1] - 4 * S])}L${fmt([c[0] + 6 * S, c[1] - 4 * S])}M${fmt([c[0] - 6 * S, c[1] + 4 * S])}L${fmt([c[0] + 6 * S, c[1] + 4 * S])}`);
  },
  // The line in from the street: a pole with its crossarm and the drop.
  wan(f, b) {
    pad(f, b);
    const { w, h } = b; const c = w / 2;
    f.cyl(c, h / 2, 7, 3, 7, DARK);
    f.post(c, h / 2, 2.2, 7, 45, METAL);
    f.box(c - 18, h / 2 - 1.5, c + 18, h / 2 + 1.5, 37, 40, METAL);
    for (const x of [c - 15, c + 15]) f.line([x, h / 2, 40], [x, h / 2, 44]);
    f.line([c + 15, h / 2, 40], [w - 2, h - 8, 20], [w - 6, h - 6, 4]);
  },
  // A mast, tapering, and the signal as arcs off its tip.
  wifi(f, b) {
    pad(f, b);
    const { w, h } = b; const c = w / 2; const r0 = 8; const r1 = 1.5; const z0 = 3; const z1 = 40; const y = h / 2;
    f.raw('right', 'r', [f.at(c + r1, y - r1, z1), f.at(c + r1, y + r1, z1), f.at(c + r0, y + r0, z0), f.at(c + r0, y - r0, z0)]);
    f.raw('left', 'l', [f.at(c - r1, y + r1, z1), f.at(c + r1, y + r1, z1), f.at(c + r0, y + r0, z0), f.at(c - r0, y + r0, z0)]);
    f.raw('top', 't', [f.at(c - r1, y - r1, z1), f.at(c + r1, y - r1, z1), f.at(c + r1, y + r1, z1), f.at(c - r1, y + r1, z1)]);
    for (const z of [12, 22, 32]) { const t = (z - z0) / (z1 - z0); const r = r0 + (r1 - r0) * t; f.line([c - r, y + r, z], [c + r, y + r, z], [c + r, y - r, z]); }
    for (const r of [7, 12, 17]) { f.arc(c + r * 0.7, y - r * 0.7, 43, r * 0.55, -60, 60); f.arc(c - r * 0.7, y + r * 0.7, 43, r * 0.55, 120, 240); }
  },
  // A phone and a tablet standing on their edges, screens to the viewer.
  clients(f, b) {
    pad(f, b);
    const { h } = b;
    const screen = (x0: number, x1: number, y: number, z0: number, z1: number) => f.raw('left', 'l', [f.at(x0, y, z1), f.at(x1, y, z1), f.at(x1, y, z0), f.at(x0, y, z0)], SCREEN);
    const y1 = h - 12;
    f.box(22, y1 - 22, 46, y1 - 18, 3, 30, DARK); screen(24, 44, y1 - 18, 6, 28);
    f.box(7, y1 - 3, 20, y1, 3, 25, DARK); screen(8.5, 18.5, y1, 6, 23);
    f.line([11, y1, 4.5], [16, y1, 4.5]);
  },
  // Ports in two rows and a stack of lights.
  switch(f, b) {
    pad(f, b);
    const { w, h } = b; const y = h - 9;
    f.box(5, 12, w - 5, y, 3, 25);
    f.line([5, y, 14], [w - 5, y, 14]);
    f.ticksLeft(9, w - 9, y, 6, 10, 4); f.ticksLeft(9, w - 9, y, 17, 10, 4);
    f.unitsRight(15, y - 3, w - 5, 5, 23, 2);
  },
  // A gate with its dark mouth.
  tunnel(f, b) {
    pad(f, b);
    const { w, h } = b; const y = h - 12;
    f.box(10, 14, w - 10, y, 3, 32);
    const mouth: Pt[] = []; for (let a = 180; a >= 0; a -= 20) { const t = (a * Math.PI) / 180; mouth.push(f.at(w / 2 + 14 * Math.cos(t), y, 12 + 14 * Math.sin(t))); }
    f.raw('left', 'l', [f.at(w / 2 - 14, y, 3), ...mouth, f.at(w / 2 + 14, y, 3)], DARK);
  },
  // Stepped: traffic goes through, not into.
  proxy(f, b) {
    pad(f, b);
    const { w } = b;
    f.box(8, 8, w - 8, w - 8, 3, 15); f.box(15, 15, w - 15, w - 15, 15, 27); f.box(22, 22, w - 22, w - 22, 27, 37);
    f.unitsLeft(12, w - 12, w - 8, 5, 13, 2); f.unitsLeft(19, w - 19, w - 15, 17, 25, 1);
  },
};

/** Too small on screen to read, and each one is an element: at the overview of a dense map the lines of a guest wait for the zoom. */
const FINE = new Set<Kind | 'dockerhost'>(['vm', 'lxc', 'container', 'dockerhost', 'bridge', 'bmc']);
const FINE_S = 0.5;

export function formOf(key: Kind | 'dockerhost', b: Box, P: Project, S: number, dense = false): Form {
  const f = new Build(P, b);
  const make = FORMS[key];
  if (make) make(f, b, S, dense); else f.box(0, 0, b.w, b.h, 0, b.zh, { main: true });
  const form = f.done();
  return dense && S < FINE_S && FINE.has(key) ? { parts: form.parts, detail: '' } : form;
}
