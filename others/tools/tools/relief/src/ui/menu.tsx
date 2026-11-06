// The status menu on the map (design 9.4): name, state and at most three values, beside the object. It never takes the pointer, so it cannot block what it describes.
import type { Entity } from '../../server/model/fact.ts';
import type { ObjectHealth } from '../../server/model/health.ts';
import { keyValues } from '../model.ts';
import type { Rect } from '../scene/project.ts';

const W = 196; const LINE = 19; const PAD = 16; const GAP = 12; const BUTTON = 36;

/** Beside the object if it fits, then above or below, then a corner of its box: an isometric box has empty corners. Always inside the map. */
export function placeMenu(box: Rect, h: number, map: { w: number; h: number }): { x: number; y: number } {
  const fits = (x: number, y: number) => x >= 4 && y >= 4 && x + W <= map.w - 4 && y + h <= map.h - 4;
  const cy = box.y + box.h / 2 - h / 2; const cx = box.x + box.w / 2 - W / 2;
  const tries: [number, number][] = [[box.x + box.w + GAP, cy], [box.x - W - GAP, cy], [cx, box.y - h - GAP], [cx, box.y + box.h + GAP]];
  for (const [x, y] of tries) if (fits(x, y)) return { x, y };
  const corners: [number, number][] = [[box.x, box.y], [box.x + box.w - W, box.y], [box.x, box.y + box.h - h], [box.x + box.w - W, box.y + box.h - h]];
  for (const [x, y] of corners) if (fits(x, y)) return { x, y };
  return { x: Math.min(map.w - W - 4, Math.max(4, cx)), y: Math.min(map.h - h - 4, Math.max(4, box.y)) };
}

/** On a touch screen there is no hover to lose, so the menu takes a tap: its button opens the modal. */
export function StatusMenu({ e, health, box, map, nowMs, onOpen }: { e: Entity; health: ObjectHealth; box: Rect; map: { w: number; h: number }; nowMs: number; onOpen?: (() => void) | undefined }) {
  const values = keyValues(e, nowMs);
  const h = PAD + LINE * (2 + values.length) + (onOpen ? BUTTON : 0);
  const { x, y } = placeMenu(box, h, map);
  return (
    <div className="status-menu" role="status" data-testid="status-menu" data-for={e.id} style={{ left: x, top: y, width: W, height: h }}>
      <b>{e.title}</b>
      <span className="st" data-health={health.state}>{health.word}</span>
      {values.map((v) => <span className="kv" key={v.label}><i>{v.label}</i>{v.text}</span>)}
      {onOpen ? <button type="button" data-testid="menu-open" onPointerDown={(ev) => ev.stopPropagation()} onPointerUp={(ev) => ev.stopPropagation()} onClick={onOpen}>상세</button> : null}
    </div>
  );
}
