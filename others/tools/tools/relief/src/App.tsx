// relief: the live map, or a fixture on the fixture server. Summary and tools, map, side panel; state in the URL hash.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../server/model/fact.ts';
import { ageS, ageText } from '../server/model/fact.ts';
import { healthOf } from '../server/model/health.ts';
import { applyMetrics, neighbour, searchMatches, type Dir, type Metrics } from './model.ts';
import { canvasMeasure, placeLabels } from './scene/labels.ts';
import { buildScene, sceneBounds } from './scene/paint.ts';
import { project } from './scene/project.ts';
import { SceneSvg } from './scene/SceneSvg.tsx';
import { METRICS, OVERLAYS, type Overlay } from './scene/style.ts';
import { DEFAULT_VIEW, formatHash, parseHash, type Theme, type View } from './state.ts';
import { ObjectDetail } from './ui/detail.tsx';
import { History } from './ui/history.tsx';
import { StatusMenu } from './ui/menu.tsx';
import { Modal } from './ui/modal.tsx';
import { Palette } from './ui/palette.tsx';
import { Panel } from './ui/panel.tsx';
import { Tree } from './ui/tree.tsx';

const ZOOM_MAX = 8;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(1, z));
const OVERLAY_KEYS: Record<string, Overlay> = { '1': 'state', '3': 'load', '4': 'basis', '5': 'fresh' };
const BASIS_LEGEND: [string, string][] = [['observed', '관측'], ['derived', '추정'], ['declared', '선언'], ['unknown', '미확인']];
/** How long a flight takes, and how close it ends. A slab is big, so it needs less. */
const POLL_TIMEOUT_MS = 4000;
const NARROW = '(max-width: 900px)';
const FLY_MS = 480;
const FLY_ZOOM = { slab: 1.6, other: 2.6 };
const FLASH_MS = 2400;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const THEME_KEY = 'relief-theme';
const storedTheme = (): Theme | null => { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };
/** A link that names a theme wins; otherwise the last choice on this browser, otherwise dark. */
const readView = (): View => { const v = parseHash(location.hash); return location.hash.includes('theme=') ? v : { ...v, theme: storedTheme() ?? v.theme }; };

function useHashView(): [View, (f: (v: View) => View) => void] {
  const [view, setView] = useState<View>(readView);
  useEffect(() => {
    const on = () => setView(readView());
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
  const [read, setRead] = useState<Snapshot | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNow] = useState(() => Date.now());
  const [size, setSize] = useState({ w: 900, h: 700 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<'overview' | 'list'>('overview');
  const [palette, setPalette] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [walking, setWalking] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [flying, setFlying] = useState(false);
  const [tapped, setTapped] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  const [qRaw, setQRaw] = useState(view.q);
  const mapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const flight = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = view.theme;
    try { localStorage.setItem(THEME_KEY, view.theme); } catch { /* a convenience: without storage the hash still holds it */ }
  }, [view.theme]);

  // One conditional read per 5 s while the tab is visible (design 8). `today` asks for no fixture: the live server has none, the fixture server defaults to it.
  useEffect(() => {
    let alive = true;
    let etag: string | null = null;
    const path = view.fx === 'today' ? 'api/snapshot' : `api/snapshot?fixture=${view.fx}`;
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(new URL(path, document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MS), headers: etag ? { 'if-none-match': etag } : {} });
        // Age is computed here, so an unchanged answer still has to move the clock: that is how a dead source goes stale on screen.
        if (r.status === 304) { if (alive) { setNow(Date.now()); setError(null); } return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = (await r.json()) as Snapshot;
        etag = r.headers.get('etag');
        if (alive) { setRead(s); setNow(Date.now()); setError(null); }
      } catch (e) { if (alive) { setNow(Date.now()); setError(String(e instanceof Error ? e.message : e).slice(0, 200)); } } // The clock moves on: a screen that lost its server must age.
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [view.fx]);

  // A hidden tab stops the flow outright, so it does not depend on the browser throttling it.
  useEffect(() => {
    const on = () => { document.documentElement.dataset.paused = document.hidden ? '1' : '0'; };
    on(); document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // A narrow screen needs the width for the map: the panel folds away by itself, and opens over it when asked for.
  useEffect(() => {
    const m = matchMedia(NARROW);
    const on = () => { setNarrow(m.matches); if (m.matches) setView((v) => (v.panel ? { ...v, panel: false } : v)); };
    on(); m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [setView]);

  const liveMap = read?.origin === 'live';

  // The load overlay reads metrics on its own, and only while it is on: the server calls PVE for them only then (design 8).
  useEffect(() => {
    if (!liveMap || view.overlay !== 'load') { setMetrics(null); return; }
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try { const r = await fetch(new URL('api/metrics', document.baseURI), { cache: 'no-store' }); if (r.ok && alive) setMetrics((await r.json()) as Metrics); } catch { /* the snapshot's last values stay */ }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [liveMap, view.overlay]);

  const snap = useMemo(() => (read ? applyMetrics(read, metrics) : null), [read, metrics]);
  const failing = liveMap ? read?.sources.find((x) => x.state === 'failing') : undefined;

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
    () => (snap ? buildScene(snap, { mode: view.mode, S, overlay: view.overlay, metric: view.metric, nowMs, sel: view.sel, dim, dense, flash }) : null),
    // The camera enters only through S: panning moves the viewBox, not the scene.
    [snap, view.mode, S, view.overlay, view.metric, nowMs, view.sel, dim, dense, flash],
  );
  const labels = useMemo(
    () => (scene ? placeLabels(scene.labels, scene.shapes, rect, { leaf: !dense || zoom >= 1.8, container: !dense || zoom >= 3 }, canvasMeasure) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, rect.x, rect.y, rect.w, rect.h, dense, zoom],
  );

  const select = useCallback((id: string | null, open = true) => setView((v) => ({ ...v, sel: id, open: id !== null && open, page: id !== null && open ? 'map' : v.page })), [setView]);
  const closePalette = useCallback(() => { setPalette(false); setQRaw(''); }, []);
  const closeModal = useCallback(() => setView((v) => ({ ...v, open: false })), [setView]);

  /**
   * The camera to an object, eased, then a highlight. Only the viewBox moves in flight: rebuilding the scene every frame would cost more than the frame has.
   * The real zoom and pan are set when it lands, so the scene it lands on is the one that stays.
   */
  const flyTo = useCallback((id: string) => {
    const b = snap?.layout[id]; const e = snap?.nodes.find((n) => n.id === id);
    if (!b || !e) return;
    const nextZoom = clampZoom(Math.max(zoom, e.kind === 'node' || e.kind === 'workstation' ? FLY_ZOOM.slab : FLY_ZOOM.other));
    const c = project(view.mode, 1)(b.x + b.w / 2, b.y + b.h / 2, b.z + b.zh / 2);
    const land = () => { setZoom(nextZoom); setPan(c); setFlying(false); setWalking(true); setFlash(id); mapRef.current?.focus({ preventScroll: true }); };
    setView((v) => ({ ...v, page: 'map', sel: id, open: false }));
    const svg = svgRef.current;
    const token = ++flight.current;
    if (calm() || !svg) { land(); return; }
    const from = [rect.x, rect.y, rect.w, rect.h];
    const scale = nextZoom / zoom; const w = rect.w / scale; const h = rect.h / scale;
    const to = [c[0] * S - w / 2, c[1] * S - h / 2, w, h];
    setFlying(true);
    const t0 = performance.now();
    const step = (now: number) => {
      if (token !== flight.current) return;
      const t = Math.min(1, (now - t0) / FLY_MS); const k = ease(t);
      svg.setAttribute('viewBox', from.map((f, i) => (f + (to[i]! - f) * k).toFixed(1)).join(' '));
      if (t < 1) requestAnimationFrame(step); else land();
    };
    requestAnimationFrame(step);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, zoom, view.mode, rect.x, rect.y, rect.w, rect.h, S, setView]);

  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), FLASH_MS); return () => clearTimeout(t); }, [flash]);
  const setZoomAt = useCallback((f: (z: number) => number) => setZoom((z) => clampZoom(f(z))), []);

  // Keyboard table (design 9.6). Tab is the browser's own.
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (palette) return; // It has the keyboard until it closes.
      // Ctrl+Space can belong to the OS or the IME, so `/` and Ctrl+K reach the same place.
      if ((ev.code === 'Space' && ev.ctrlKey) || (ev.key === 'k' && (ev.ctrlKey || ev.metaKey)) || (ev.key === '/' && !typing)) { ev.preventDefault(); setPalette(true); return; }
      if (ev.key === 'Escape') {
        if (typing) { (t as HTMLInputElement).blur(); return; }
        setWalking(false);
        setView((v) => (v.open ? { ...v, open: false } : { ...v, sel: null }));
        return;
      }
      if (view.open || typing || ev.ctrlKey || ev.metaKey || ev.altKey || !snap) return;
      if (ev.key === 'p') { ev.preventDefault(); setView((v) => ({ ...v, panel: !v.panel })); return; }
      if (ev.key === 'h') { ev.preventDefault(); setView((v) => ({ ...v, page: v.page === 'map' ? 'history' : 'map' })); return; }
      if (ev.key === 't') { ev.preventDefault(); setView((v) => ({ ...v, theme: v.theme === 'dark' ? 'light' : 'dark' })); return; }
      if (view.page !== 'map') return;
      const dirs: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      const d = dirs[ev.key];
      if (d || ev.key === '[' || ev.key === ']') {
        // Arrows inside the list belong to the list's own focus; the map takes them elsewhere.
        ev.preventDefault();
        setWalking(true);
        setView((v) => { const n = neighbour(snap, v.sel, d ?? (ev.key as '[' | ']'), v.mode); return n ? { ...v, sel: n } : v; });
        return;
      }
      switch (ev.key) {
        case 'Enter': if (t?.tagName === 'BUTTON') return; /* a focused button keeps its own Enter */ setView((v) => (v.sel ? { ...v, open: true } : v)); break;
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
  }, [snap, setView, setZoomAt, resetCamera, palette, view.open, view.page]);

  // Wheel zoom and drag pan on the map.
  useEffect(() => {
    const el = mapRef.current; if (!el) return;
    const wheel = (ev: WheelEvent) => { ev.preventDefault(); setZoomAt((z) => z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [setZoomAt]);
  const drag = useRef<{ x: number; y: number; moved: boolean; c: [number, number] } | null>(null);
  // Two fingers are a pinch. It is one distance and one ratio, on the same pointer events as the pan.
  const touches = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const gap = () => { const [a, b] = [...touches.current.values()]; return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0; };
  const onDown = (ev: React.PointerEvent) => {
    touches.current.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (touches.current.size === 2) { drag.current = null; pinch.current = { d: gap(), z: zoom }; return; }
    drag.current = { x: ev.clientX, y: ev.clientY, moved: false, c: centre1 };
  };
  const hoverAt = (ev: React.PointerEvent) => {
    if (ev.pointerType === 'touch') return; // No hover on glass: the first tap does this job.
    const id = drag.current ? null : ((ev.target as Element).closest('[data-id]') as HTMLElement | null)?.dataset.id ?? null;
    setHover(id); // React drops the same value: the scene is not touched unless the object changes.
    if (id) setWalking(false);
  };
  const onMove = (ev: React.PointerEvent) => {
    hoverAt(ev);
    if (touches.current.has(ev.pointerId)) touches.current.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pinch.current && touches.current.size === 2) { const p = pinch.current; setZoom(clampZoom((p.z * gap()) / Math.max(1, p.d))); return; }
    const d = drag.current; if (!d) return;
    const dx = ev.clientX - d.x; const dy = ev.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setPan([d.c[0] - dx / S, d.c[1] - dy / S]);
  };
  const onUp = (ev: React.PointerEvent) => {
    touches.current.delete(ev.pointerId);
    if (pinch.current) { if (touches.current.size === 0) pinch.current = null; drag.current = null; return; }
    const d = drag.current; drag.current = null;
    if (d?.moved) return;
    const g = (ev.target as Element).closest('[data-id]') as HTMLElement | null;
    const id = g?.dataset.id;
    if (id && snap?.nodes.some((n) => n.id === id)) {
      // A mouse has already shown the menu by hovering. A finger has not, so its first tap does that and the second opens.
      if (ev.pointerType === 'touch' && tapped !== id) { setTapped(id); setWalking(true); select(id, false); return; }
      setTapped(null); select(id);
    } else if (!g) { setTapped(null); select(null); }
  };

  const entity = snap && view.sel ? snap.nodes.find((n) => n.id === view.sel) ?? null : null;
  // A link can name an object that is gone. The hash keeps no modal open on nothing, or the shortcuts would sleep behind a dialog nobody can see.
  useEffect(() => { if (snap && view.open && !entity) setView((v) => ({ ...v, open: false, sel: null })); }, [snap, view.open, entity, setView]);
  const health = useMemo(() => (snap ? healthOf(snap, nowMs, { offline: error !== null }) : null), [snap, nowMs, error]);
  const sum = health?.system ?? null;
  const lastAge = sum?.lastAt ? ageS(sum.lastAt, nowMs) : null;
  const open = (id: string) => select(id);

  // The menu reads the scene's own box, so pan and zoom carry it along.
  const modalOpen = view.open && !!entity;
  const menuId = flying || modalOpen || palette || view.page !== 'map' ? null : hover ?? (walking ? view.sel : null);
  const menuEntity = menuId ? snap?.nodes.find((n) => n.id === menuId) : undefined;
  const menuShape = menuId ? scene?.shapes.find((x) => x.id === menuId) : undefined;

  return (
    <div className={`app${view.panel && view.page === 'map' && !narrow ? '' : ' wide'}${narrow ? ' narrow' : ''}`}>
      <header>
        <div className="statusline">
          <b className="brand">relief</b>
          <div className="seg pages" role="tablist" aria-label="화면">
            <button type="button" role="tab" aria-selected={view.page === 'map'} className={view.page === 'map' ? 'on' : ''} data-testid="page-map" onClick={() => setView((v) => ({ ...v, page: 'map' }))}>지도</button>
            <button type="button" role="tab" aria-selected={view.page === 'history'} className={view.page === 'history' ? 'on' : ''} data-testid="page-history" onClick={() => setView((v) => ({ ...v, page: 'history' }))}>변경</button>
          </div>
          <span className="verdict" data-testid="verdict" data-verdict={sum?.state ?? 'unknown'} title={sum ? `필수 확인 ${sum.met}/${sum.required} · 해당 없음 ${sum.notApplicable}` : undefined}><i />{sum?.text ?? '불러오는 중'}</span>
          {sum ? (
            <dl className="stats" data-testid="summary">
              <div className={sum.problems ? 'stat hot bad' : 'stat'} data-testid="stat-problems"><dt>문제</dt><dd><b>{sum.problems}</b></dd></div>
              <div className={sum.warnings ? 'stat hot' : 'stat'} data-testid="stat-warnings"><dt>경고</dt><dd><b>{sum.warnings}</b></dd></div>
              <div className={sum.stale ? 'stat hot' : 'stat'} data-testid="stat-stale"><dt>낡은 출처</dt><dd><b>{sum.stale}</b></dd></div>
              <div className="stat" data-testid="stat-blanks"><dt>비교 불가</dt><dd><b>{sum.blanks}</b></dd></div>
              <div className="stat" data-testid="stat-last"><dt>수집</dt><dd><b>{lastAge === null ? '없음' : ageText(lastAge)}</b></dd></div>
            </dl>
          ) : null}
          <span className="spring" />
          {read && !liveMap ? <span className="synthetic" data-testid="synthetic">합성 fixture</span> : null}
          <button type="button" className="plain" data-testid="panel-toggle" aria-pressed={view.panel} onClick={() => setView((v) => ({ ...v, panel: !v.panel }))}>{view.panel ? '패널 접기' : '패널 열기'}</button>
          <button type="button" className="plain" data-testid="theme" aria-label="테마 전환" onClick={() => setView((v) => ({ ...v, theme: v.theme === 'dark' ? 'light' : 'dark' }))}>{view.theme === 'dark' ? '밝게' : '어둡게'}</button>
        </div>
        <div className="tools" hidden={view.page !== 'map'}>
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
          <button type="button" className="find" data-testid="palette-open" onClick={() => setPalette(true)}>찾기 <kbd>Ctrl+Space</kbd> <kbd>/</kbd></button>
          <div className="seg" role="group" aria-label="확대">
            <button type="button" aria-label="축소" onClick={() => setZoomAt((z) => z / 1.25)}>−</button>
            <button type="button" aria-label="맞춤" onClick={resetCamera}>맞춤</button>
            <button type="button" aria-label="확대" onClick={() => setZoomAt((z) => z * 1.25)}>+</button>
          </div>
          {read && !liveMap ? <div className="seg" role="group" aria-label="fixture">
            <button type="button" className={view.fx === 'today' ? 'on' : ''} onClick={() => setView((v) => ({ ...DEFAULT_VIEW, ...v, fx: 'today', sel: null, open: false }))} data-testid="fx-today">오늘 모양</button>
            <button type="button" className={view.fx === 'large' ? 'on' : ''} onClick={() => setView((v) => ({ ...v, fx: 'large', sel: null, open: false }))} data-testid="fx-large">299개</button>
          </div> : null}
        </div>
      </header>
      <main hidden={view.page !== 'map'}>
        <div className="map" ref={mapRef} tabIndex={0} role="application" aria-label="지도. 화살표로 객체 이동, Enter로 상세, 2는 3D와 2D 전환" data-testid="map"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)}>
          {scene && labels ? <SceneSvg svgRef={svgRef} prims={scene.prims} labels={labels.placed} hiddenLod={labels.lodHidden.length} hiddenCollision={labels.hidden.length} view={[rect.x, rect.y, rect.w, rect.h]} /> : <p className="loading">{error ? `읽지 못했다: ${error}` : '불러오는 중'}</p>}
          {error && snap ? <p className="stalebar">갱신 실패 · 마지막 값 · {error}</p> : null}
          {!error && failing ? <p className="stalebar" data-testid="source-failing">수집 실패 · {failing.why ?? '이유 없음'} · 마지막 값</p> : null}
          {menuEntity && menuShape ? <StatusMenu e={menuEntity} health={health!.objects.get(menuEntity.id)!} box={{ x: menuShape.bbox.x - rect.x, y: menuShape.bbox.y - rect.y, w: menuShape.bbox.w, h: menuShape.bbox.h }} map={size} nowMs={nowMs} onOpen={tapped === menuEntity.id ? () => { setTapped(null); select(menuEntity.id); } : undefined} /> : null}
        </div>
        <div className="legend" data-testid="legend">
          <h4>근거</h4>
          {BASIS_LEGEND.map(([k, t]) => <span key={k}><span className={`sw ${k}`} />{t}</span>)}
          <span className="sep" />
          <span data-testid="legend-flow" title="패킷 수가 측정한 전송률이다. 0이면 없고, 10 KB/s까지 1개, 이후 10배마다 1개씩, 한 방향 6개까지. 속도는 항상 같다."><span className="sw-flow" />패킷 수 = 측정 트래픽</span>
          <span data-testid="legend-none" title="측정한 값이 없는 연결이다. 상태 색만 보이고 패킷이 없다. 선의 호버가 어느 쪽인지 말한다.">정지 = 0 또는 트래픽 측정 없음</span>
          <span data-testid="legend-links"><span className="sw-l healthy" />정상<span className="sw-l warning" />경고<span className="sw-l down" />끊김<span className="sw-l stale" />낡음<span className="sw-l unknown" />모름</span>
          {view.overlay === 'state' ? <span><span className="sw st-stopped" />중지<span className="sw st-warn" />기동·중지 중<span className="sw st-error" />오류</span> : null}
          {view.overlay === 'load' ? <span>윗면 비율 = {METRICS.find((m) => m.id === view.metric)!.label}</span> : null}
          {view.overlay === 'fresh' ? <span><span className="sw f1" />신선<span className="sw f2" />곧 낡음<span className="sw f3" />낡음</span> : null}
          <span className="hint">p 패널 · h 변경 · t 테마</span>
        </div>
      </main>
      {view.page === 'history' && snap ? <div className="page"><History snap={snap} nowMs={nowMs} onSelect={(id) => flyTo(id)} /></div> : null}
      <aside hidden={!view.panel || view.page !== 'map'}>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>현황</button>
          <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')} data-testid="tab-list">목록</button>
        </div>
        <div className="body">
          {snap ? (tab === 'overview'
            ? <Panel snap={snap} nowMs={nowMs} system={sum!} onSelect={open} />
            : <Tree snap={snap} sel={view.sel} only={dim} health={health!.objects} onSelect={open} />) : null}
        </div>
      </aside>
      {modalOpen && entity && snap ? <Modal key={entity.id} onClose={closeModal}><ObjectDetail snap={snap} nowMs={nowMs} e={entity} fx={view.fx} health={health!.objects.get(entity.id)!} /></Modal> : null}
      {palette && snap ? <Palette snap={snap} query={qRaw} onQuery={setQRaw} onPick={(id) => { closePalette(); flyTo(id); }} onClose={closePalette} /> : null}
    </div>
  );
}
