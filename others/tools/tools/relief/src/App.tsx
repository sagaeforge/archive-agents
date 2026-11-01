// relief, Phase 1: a static map of a fixture. Header, map, side panel; state in the URL hash.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../server/model/fact.ts';
import { neighbour, searchMatches, type Dir } from './model.ts';
import { canvasMeasure, placeLabels } from './scene/labels.ts';
import { buildScene, sceneBounds } from './scene/paint.ts';
import { SceneSvg } from './scene/SceneSvg.tsx';
import { METRICS, OVERLAYS, type Overlay } from './scene/style.ts';
import { DEFAULT_VIEW, formatHash, parseHash, type View } from './state.ts';
import { Panel } from './ui/panel.tsx';
import { Tree } from './ui/tree.tsx';

const ZOOM_MAX = 8;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(1, z));
const OVERLAY_KEYS: Record<string, Overlay> = { '1': 'state', '3': 'load', '4': 'basis', '5': 'fresh' };
const BASIS_LEGEND: [string, string][] = [['observed', '관측'], ['derived', '추정'], ['declared', '선언'], ['unknown', '미확인']];

function useHashView(): [View, (f: (v: View) => View) => void] {
  const [view, setView] = useState<View>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setView(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const update = useCallback((f: (v: View) => View) => {
    setView((cur) => {
      const next = f(cur);
      const h = formatHash(next);
      if (h !== location.hash && !(h === '#/' && location.hash === '')) history.replaceState(null, '', h);
      return next;
    });
  }, []);
  return [view, update];
}

export function App() {
  const [view, setView] = useHashView();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNow] = useState(() => Date.now());
  const [size, setSize] = useState({ w: 900, h: 700 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<'detail' | 'list'>('detail');
  const [qRaw, setQRaw] = useState(view.q);
  const mapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // One read per 5 s while the tab is visible (design 8). Phase 2 makes it conditional on seq.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(new URL(`api/snapshot?fixture=${view.fx}`, document.baseURI), { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = (await r.json()) as Snapshot;
        if (alive) { setSnap(s); setNow(Date.now()); setError(null); }
      } catch (e) { if (alive) setError(String(e instanceof Error ? e.message : e).slice(0, 200)); }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [view.fx]);

  useEffect(() => {
    const el = mapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) }));
    ro.observe(el); setSize({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  // Search: NFC, 150 ms debounce so an IME composition does not fire per keystroke (design 9.4).
  useEffect(() => {
    const t = setTimeout(() => setView((v) => (v.q === qRaw.normalize('NFC') ? v : { ...v, q: qRaw.normalize('NFC') })), 150);
    return () => clearTimeout(t);
  }, [qRaw, setView]);

  const resetCamera = useCallback(() => { setZoom(1); setPan(null); }, []);
  useEffect(resetCamera, [view.mode, view.fx, resetCamera]);

  const bounds1 = useMemo(() => (snap ? sceneBounds(snap, view.mode) : null), [snap, view.mode]);
  const Sfit = bounds1 ? Math.min(size.w / (bounds1[2] - bounds1[0] + 48), size.h / (bounds1[3] - bounds1[1] + 88)) * 0.96 : 1;
  const S = Sfit * zoom;
  const centre1: [number, number] = pan ?? (bounds1 ? [(bounds1[0] + bounds1[2]) / 2, (bounds1[1] + bounds1[3]) / 2] : [0, 0]);
  const rect = { x: centre1[0] * S - size.w / 2, y: centre1[1] * S - size.h / 2, w: size.w, h: size.h };

  const dim = useMemo(() => (snap ? searchMatches(snap, view.q) : null), [snap, view.q]);
  const dense = (snap?.nodes.length ?? 0) >= 60;
  const scene = useMemo(
    () => (snap ? buildScene(snap, { mode: view.mode, S, overlay: view.overlay, metric: view.metric, nowMs, sel: view.sel, dim, dense }) : null),
    // The camera enters only through S: panning moves the viewBox, not the scene.
    [snap, view.mode, S, view.overlay, view.metric, nowMs, view.sel, dim, dense],
  );
  const labels = useMemo(
    () => (scene ? placeLabels(scene.labels, scene.shapes, rect, { leaf: !dense || zoom >= 1.8, container: !dense || zoom >= 3 }, canvasMeasure) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, rect.x, rect.y, rect.w, rect.h, dense, zoom],
  );

  const select = useCallback((id: string | null, open = true) => setView((v) => ({ ...v, sel: id, open: id !== null && open })), [setView]);
  const setZoomAt = useCallback((f: (z: number) => number) => setZoom((z) => clampZoom(f(z))), []);

  // Keyboard table (design 9.6). Tab is the browser's own.
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (ev.key === 'Escape') {
        if (typing) { (t as HTMLInputElement).blur(); return; }
        setView((v) => (v.open ? { ...v, open: false } : { ...v, sel: null }));
        return;
      }
      if ((ev.key === 'k' && (ev.ctrlKey || ev.metaKey)) || (ev.key === '/' && !typing)) { ev.preventDefault(); searchRef.current?.focus(); return; }
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey || !snap) return;
      const dirs: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      const d = dirs[ev.key];
      if (d || ev.key === '[' || ev.key === ']') {
        // Arrows inside the list belong to the list's own focus; the map takes them elsewhere.
        ev.preventDefault();
        setView((v) => { const n = neighbour(snap, v.sel, d ?? (ev.key as '[' | ']'), v.mode); return n ? { ...v, sel: n } : v; });
        return;
      }
      switch (ev.key) {
        case 'Enter': setView((v) => (v.sel ? { ...v, open: true } : v)); break;
        case '2': setView((v) => ({ ...v, mode: v.mode === 'iso' ? '2d' : 'iso' })); break;
        // The design gives `2` to both the projection (9.2, 9.6) and overlay 2. The projection keeps it; the overlays take 1, 3, 4, 5.
        case '1': case '3': case '4': case '5': setView((v) => ({ ...v, overlay: OVERLAY_KEYS[ev.key]! })); break;
        case '+': case '=': setZoomAt((z) => z * 1.25); break;
        case '-': case '_': setZoomAt((z) => z / 1.25); break;
        case '0': resetCamera(); break;
        default: return;
      }
      ev.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [snap, setView, setZoomAt, resetCamera]);

  // Wheel zoom and drag pan on the map.
  useEffect(() => {
    const el = mapRef.current; if (!el) return;
    const wheel = (ev: WheelEvent) => { ev.preventDefault(); setZoomAt((z) => z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [setZoomAt]);
  const drag = useRef<{ x: number; y: number; moved: boolean; c: [number, number] } | null>(null);
  const onDown = (ev: React.PointerEvent) => { drag.current = { x: ev.clientX, y: ev.clientY, moved: false, c: centre1 }; };
  const onMove = (ev: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = ev.clientX - d.x; const dy = ev.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setPan([d.c[0] - dx / S, d.c[1] - dy / S]);
  };
  const onUp = (ev: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (d?.moved) return;
    const g = (ev.target as Element).closest('[data-id]') as HTMLElement | null;
    const id = g?.dataset.id;
    if (id && snap?.nodes.some((n) => n.id === id)) select(id); else if (!g) select(null);
  };

  const entity = snap && view.sel ? snap.nodes.find((n) => n.id === view.sel) ?? null : null;

  return (
    <div className="app">
      <header>
        <b>relief</b>
        <div className="seg" role="group" aria-label="투영">
          <button type="button" className={view.mode === 'iso' ? 'on' : ''} aria-pressed={view.mode === 'iso'} onClick={() => setView((v) => ({ ...v, mode: 'iso' }))} data-testid="mode-iso">3D</button>
          <button type="button" className={view.mode === '2d' ? 'on' : ''} aria-pressed={view.mode === '2d'} onClick={() => setView((v) => ({ ...v, mode: '2d' }))} data-testid="mode-2d">2D</button>
        </div>
        <div className="seg" role="group" aria-label="오버레이">
          {OVERLAYS.map((o) => (
            <button key={o.id} type="button" className={view.overlay === o.id ? 'on' : ''} aria-pressed={view.overlay === o.id} data-testid={`overlay-${o.id}`}
              onClick={() => setView((v) => ({ ...v, overlay: o.id as Overlay }))}>{o.label}</button>
          ))}
        </div>
        {view.overlay === 'load' ? (
          <div className="seg" role="group" aria-label="부하 값">
            {METRICS.map((m) => <button key={m.id} type="button" className={view.metric === m.id ? 'on' : ''} aria-pressed={view.metric === m.id} onClick={() => setView((v) => ({ ...v, metric: m.id }))}>{m.label}</button>)}
          </div>
        ) : null}
        <input ref={searchRef} className="search" type="search" placeholder="검색  /" aria-label="검색" value={qRaw} onChange={(e) => setQRaw(e.target.value)} data-testid="search" />
        <div className="seg" role="group" aria-label="확대">
          <button type="button" aria-label="축소" onClick={() => setZoomAt((z) => z / 1.25)}>−</button>
          <button type="button" aria-label="맞춤" onClick={resetCamera}>맞춤</button>
          <button type="button" aria-label="확대" onClick={() => setZoomAt((z) => z * 1.25)}>+</button>
        </div>
        <div className="seg chip" role="group" aria-label="fixture">
          합성 fixture
          <button type="button" className={view.fx === 'today' ? 'on' : ''} onClick={() => setView((v) => ({ ...DEFAULT_VIEW, ...v, fx: 'today', sel: null, open: false }))} data-testid="fx-today">오늘 모양</button>
          <button type="button" className={view.fx === 'large' ? 'on' : ''} onClick={() => setView((v) => ({ ...v, fx: 'large', sel: null, open: false }))} data-testid="fx-large">299개</button>
        </div>
      </header>
      <main>
        <div className="map" ref={mapRef} tabIndex={0} role="application" aria-label="지도. 화살표로 객체 이동, 2는 3D와 2D 전환" data-testid="map"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          {scene && labels ? <SceneSvg prims={scene.prims} labels={labels.placed} hiddenLod={labels.lodHidden.length} hiddenCollision={labels.hidden.length} view={[rect.x, rect.y, rect.w, rect.h]} /> : <p className="loading">{error ? `읽지 못했다: ${error}` : '불러오는 중'}</p>}
          {error && snap ? <p className="stalebar">갱신 실패 · 마지막 값 · {error}</p> : null}
        </div>
        <div className="legend" data-testid="legend">
          <h4>근거</h4>
          {BASIS_LEGEND.map(([k, t]) => <span key={k}><span className={`sw ${k}`} />{t}</span>)}
          <span className="sep" />
          <span>낡음은 흐리게</span>
          {view.overlay === 'state' ? <span><span className="sw st-stopped" />중지<span className="sw st-warn" />기동·중지 중<span className="sw st-error" />오류</span> : null}
          {view.overlay === 'load' ? <span>윗면을 채운 비율 = {METRICS.find((m) => m.id === view.metric)!.label}</span> : null}
          {view.overlay === 'fresh' ? <span><span className="sw f1" />신선<span className="sw f2" />곧 낡음<span className="sw f3" />낡음</span> : null}
          <span className="hint">1 상태 · 3 부하 · 4 근거 · 5 신선도 · 2 투영 · / 검색</span>
        </div>
      </main>
      <aside>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'detail'} className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>상세</button>
          <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')} data-testid="tab-list">목록</button>
          {view.open ? <button type="button" className="close" aria-label="패널 닫기" onClick={() => setView((v) => ({ ...v, open: false }))}>닫기</button> : null}
        </div>
        <div className="body">
          {snap ? (tab === 'detail'
            ? <Panel snap={snap} nowMs={nowMs} entity={view.open ? entity : null} onSelect={(id) => select(id)} />
            : <Tree snap={snap} sel={view.sel} only={dim} onSelect={(id) => select(id)} />) : null}
        </div>
      </aside>
    </div>
  );
}
