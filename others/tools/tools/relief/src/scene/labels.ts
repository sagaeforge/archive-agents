// Label placement (design 9.5): fixed 12 px text on a horizontal pill. A label never covers an object's drawn faces; it stands beside
// the object with a leader line when the object has no free surface of its own. Collisions hide the lower priority, and the hidden
// are counted apart from those a zoom level leaves out on purpose.
import { bboxOf, inPolygon, rectsHit, rectHitsPoly } from './geom.ts';
import type { LabelCand, Shape } from './paint.ts';
import type { Pt, Rect } from './project.ts';

export { inPolygon } from './geom.ts';
export const FONT = '"Malgun Gothic","Noto Sans KR",sans-serif';
export const FONT_PX = 12;
export const PILL_H = FONT_PX + 7;

export type Measure = (text: string) => number;
export type Placed = { id: string; text: string; x: number; y: number; w: number; h: number; at: Pt; anchor: Pt | null; color?: string; lead: boolean; alert?: boolean };
export type LabelLod = { leaf: boolean; container: boolean };

/** Width estimate for tests and for the first paint before a canvas exists: Hangul and CJK are full width. */
export const estimateWidth: Measure = (s) => [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.58), 0) * FONT_PX;

let ctx: CanvasRenderingContext2D | null | undefined;
/** Real glyph widths from the browser's own font (design 15: other machines differ from the one the spike looked at). */
export const canvasMeasure: Measure = (text) => {
  if (ctx === undefined) { try { ctx = document.createElement('canvas').getContext('2d'); if (ctx) ctx.font = `500 ${FONT_PX}px ${FONT}`; } catch { ctx = null; } }
  return ctx ? ctx.measureText(text).width : estimateWidth(text);
};

const GAPS = [3, 12, 26, 44, 70, 100];

/** Candidate rectangles around a box, nearest first, above before below. */
function ring(b: Rect, w: number, h: number): Rect[] {
  const out: Rect[] = [];
  const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
  for (const g of GAPS) {
    out.push(
      { x: cx - w / 2, y: b.y - g - h, w, h }, { x: b.x + b.w - w, y: b.y - g - h, w, h }, { x: b.x, y: b.y - g - h, w, h },
      { x: b.x + b.w + g, y: cy - h / 2, w, h }, { x: b.x - g - w, y: cy - h / 2, w, h },
      { x: cx - w / 2, y: b.y + b.h + g, w, h }, { x: b.x + b.w - w, y: b.y + b.h + g, w, h }, { x: b.x, y: b.y + b.h + g, w, h },
      { x: b.x + b.w + g, y: b.y - g - h, w, h }, { x: b.x - g - w, y: b.y - g - h, w, h },
      { x: b.x + b.w + g, y: b.y + b.h + g, w, h }, { x: b.x - g - w, y: b.y + b.h + g, w, h },
    );
  }
  return out;
}

export type PlaceResult = { placed: Placed[]; hidden: string[]; lodHidden: string[] };

export function placeLabels(cands: LabelCand[], shapes: Shape[], view: Rect, lod: LabelLod, measure: Measure): PlaceResult {
  const placed: (Rect & { l: LabelCand })[] = []; const hidden: string[] = []; const lodHidden: string[] = [];
  const list: LabelCand[] = [];
  for (const l of cands) (l.kind === 'container' ? lod.container : l.leaf ? lod.leaf : true) ? list.push(l) : lodHidden.push(l.id);
  for (const l of [...list].sort((a, b) => a.pr - b.pr)) {
    const w = measure(l.text) + 12; const h = PILL_H;
    const own = new Set(l.own);
    // Only shapes that could meet any candidate are tested closely: those near this object.
    const near: Rect = { x: l.box.x - 120 - w, y: l.box.y - 120 - h, w: l.box.w + 240 + 2 * w, h: l.box.h + 240 + 2 * h };
    const blockers = shapes.filter((s) => !own.has(s.id) && !(s.id === l.id && l.onOwn) && rectsHit(s.bbox, near));
    const rects: Rect[] = [...(l.strips ?? []).map(([x, y]) => ({ x: x - w / 2, y: y - h / 2, w, h })), ...ring(l.box, w, h)];
    let done = false;
    for (const r of rects) {
      const inside = r.x >= view.x + 2 && r.y >= view.y + 2 && r.x + w <= view.x + view.w - 2 && r.y + h <= view.y + view.h - 2;
      if (!inside || placed.some((p) => rectsHit(r, p, 3))) continue;
      if (blockers.some((s) => rectsHit(r, s.bbox) && s.polys.some((p) => rectHitsPoly(r, p)))) continue;
      placed.push({ ...r, l }); done = true; break;
    }
    if (!done) hidden.push(l.id);
  }
  return {
    hidden, lodHidden,
    placed: placed.map(({ x, y, w, h, l }) => {
      const at: Pt = [x + w / 2, y + h / 2];
      const lead = !!l.anchor && (l.onOwn ? !inPolygon(at, l.top) : Math.hypot(l.anchor[0] - at[0], l.anchor[1] - at[1]) > 18);
      return { id: l.id, text: l.text, x, y, w, h, at, anchor: l.anchor, ...(l.color ? { color: l.color } : {}), ...(l.alert ? { alert: true } : {}), lead };
    }),
  };
}
export { bboxOf };
