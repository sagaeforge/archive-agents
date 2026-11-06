// The filter gizmo at the lower left of the workspace (design v2 2.3): a small circle like the origin gizmo of a 3D view.
import { useEffect, useRef, useState } from 'react';
import { isComposing } from '../../wm/model.ts';
import { AXES, AXIS_LABEL, isAll, summary, type Axis } from './model.ts';
import type { Gizmo as GizmoState } from './useGizmo.ts';
import './gizmo.css';

const LONG_PRESS_MS = 500;
const DIGIT = /^Digit([0-5])$/;

export function Gizmo({ selection, only, toggle, all }: GizmoState) {
  // One Tab stop (roving): the arrows walk the centre and the five axes, so the gizmo does not add eleven stops to the page's Tab order.
  const [stop, setStop] = useState(0);
  const root = useRef<HTMLDivElement>(null), center = useRef<HTMLButtonElement>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  useEffect(() => {
    // Alt+G focuses the gizmo; 0 to 5 and Shift+digit then work while focus is in it. `code`, not `key`: Shift+digit and a Korean IME change `key`.
    const key = (e: KeyboardEvent) => {
      if (isComposing(e) || e.ctrlKey || e.metaKey || !e.altKey || e.code !== 'KeyG') return;
      e.preventDefault();
      center.current?.focus();
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (press.current.timer) clearTimeout(press.current.timer); };
  }, []);
  const digit = (e: React.KeyboardEvent) => {
    if (isComposing(e.nativeEvent) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { (document.activeElement as HTMLElement | null)?.blur(); return; }
    if (e.key.startsWith('Arrow')) {
      const items = [...(root.current?.querySelectorAll<HTMLElement>('[data-stop]') ?? [])], at = items.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      items[(at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    const m = DIGIT.exec(e.nativeEvent.code);
    if (!m) return;
    e.preventDefault();
    const n = Number(m[1]);
    if (n === 0) all(); else if (e.shiftKey) toggle(AXES[n - 1]!); else only(AXES[n - 1]!);
  };
  const pick = (a: Axis, e: React.MouseEvent) => {
    if (press.current.fired) { press.current.fired = false; return; }
    if (e.shiftKey) toggle(a); else only(a);
  };
  const touch = (a: Axis) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      press.current.fired = false;
      press.current.timer = setTimeout(() => { press.current.fired = true; press.current.timer = null; toggle(a); }, LONG_PRESS_MS);
    },
    onPointerUp: () => { if (press.current.timer) { clearTimeout(press.current.timer); press.current.timer = null; } },
    onPointerCancel: () => { if (press.current.timer) { clearTimeout(press.current.timer); press.current.timer = null; } },
  });
  const full = isAll(selection);
  return <section className="gizmo-box" aria-label="그래프 필터" data-testid="gizmo-box">
    <div className="gizmo" data-testid="gizmo" role="group" aria-label="보이는 것 고르기" aria-keyshortcuts="Alt+G" ref={root} onKeyDown={digit}>
      <button type="button" className="gizmo-all" data-testid="gizmo-all" ref={center} data-stop="0" tabIndex={stop === 0 ? 0 : -1} onFocus={() => { setStop(0); }} aria-label="전체" aria-pressed={full} title="전체 (0)" onClick={all}>0</button>
      {AXES.map((a, i) => {
        const angle = (-90 + 72 * i) * Math.PI / 180;
        return <button type="button" key={a} className="gizmo-axis" data-axis={a} data-testid={`gizmo-axis-${a}`} aria-label={AXIS_LABEL[a]} aria-pressed={!full && selection.has(a)} data-stop={i + 1} tabIndex={stop === i + 1 ? 0 : -1} onFocus={() => { setStop(i + 1); }}
          title={`${AXIS_LABEL[a]} (${i + 1}) · Shift: 더하기·빼기`} style={{ left: `calc(50% + ${(Math.cos(angle) * 31).toFixed(1)}px - 12px)`, top: `calc(50% + ${(Math.sin(angle) * 31).toFixed(1)}px - 12px)` }}
          onClick={(e) => { pick(a, e); }} {...touch(a)}>{i + 1}</button>;
      })}
      <div className="gizmo-picks" data-testid="gizmo-picks">
        {AXES.map((a, i) => <button type="button" key={a} data-testid={`gizmo-pick-${a}`} tabIndex={-1} aria-label={`${AXIS_LABEL[a]}만`} aria-pressed={!full && selection.size === 1 && selection.has(a)} onClick={() => { only(a); }}><kbd>{i + 1}</kbd> {AXIS_LABEL[a]}만</button>)}
      </div>
    </div>
    <p className="gizmo-summary" data-testid="gizmo-summary" aria-live="polite">보이는 것: {summary(selection)}</p>
  </section>;
}
