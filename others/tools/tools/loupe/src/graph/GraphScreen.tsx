// /graph (design 3, 6). The overview is what is shown; coordinates come from the layout cache, so a filter never moves a node.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { Button } from '@/components/ui/button';
import { Chip, ErrorCard, Loading, TimeMark } from '../components/bits.tsx';
import { NodeLink, fallbackLabel } from '../components/NodeLink.tsx';
import { useGraphFacets, useNeighborhood, useOverview, useRefreshOverview } from '../data/graph.ts';
import { envelopeStore } from '../data/envelopeStore.ts';
import { useSchemaCatalog } from '../data/hooks.ts';
import { SUPERSEDED_EDGES, type GraphParams } from '../routes/search.ts';
import { useIsPastView } from '../time/useTimeBasis.ts';
import { FilterPanel } from './FilterPanel.tsx';
import { canUse20k, DEFAULT_LIMITS, profileFor, readWebglRenderer, WIDE_LIMITS } from './gpuProfile.ts';
import { decodeGraph, mergeGraphs, truncationOf, type GraphData } from './model.ts';
import { SelectionPanel } from './SelectionPanel.tsx';
import { useFocusMerge } from './useFocusMerge.ts';
import { coldEstimateMs, useGraphLayout, type LayoutState } from './useGraphLayout.ts';
import { GraphView } from './view.ts';

const n = (v: number) => v.toLocaleString('ko-KR');

function ColdProgress({ state }: { state: Extract<LayoutState, { phase: 'cold' }> }) {
  const est = coldEstimateMs(state.nodes);
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const t = setInterval(() => { setNow(performance.now()); }, 250); return () => { clearInterval(t); }; }, []);
  // The worker reports only at the end (design 6.2), so the bar follows the clock and stops short of full.
  const value = Math.min(95, Math.round(((now - state.startedAt) / est) * 100));
  return (
    <div className="graph-band" data-testid="graph-progress">
      <span>레이아웃을 계산하는 중이다. 약 {Math.max(1, Math.round(est / 1000))}초 걸린다. 나머지 화면은 계속 쓸 수 있다.</span>
      <progress max={100} value={value} aria-label="레이아웃 계산" />
    </div>
  );
}

export function GraphScreen() {
  useScreenTitle('그래프');
  const search = useSearch({ from: '/graph' });
  const navigate = useNavigate();
  const setSearch = useCallback((patch: Partial<Record<keyof GraphParams, unknown>>, replace = false) => {
    void navigate({ to: '/graph', search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace, resetScroll: false } as never);
  }, [navigate]);

  const gpu = useMemo(() => { const renderer = readWebglRenderer(); return { renderer, profile: profileFor(renderer) }; }, []);
  const [confirmedWide, setConfirmedWide] = useState(false);
  const wanted20k = search.view === '20k';
  const allowed20k = canUse20k(gpu.profile);
  const limits = wanted20k && allowed20k && confirmedWide ? WIDE_LIMITS : DEFAULT_LIMITS;

  const filters = { types: search.types, rtypes: search.rtypes, domain: search.domain, edge_status: search.edge_status };
  const schema = useSchemaCatalog();
  const facets = useGraphFacets({ types: search.types, domain: search.domain });
  const overview = useOverview(filters, limits);
  const neighbors = useNeighborhood(search.focus, { depth: search.depth ?? 1, rtypes: search.rtypes, edge_status: search.edge_status });
  const deadFocus = useFocusMerge(search.focus);

  const received = useMemo(() => (overview.data ? decodeGraph(overview.data.data) : null), [overview.data]);
  const data = useMemo<GraphData | null>(() => (received ? mergeGraphs(received, neighbors.data ? decodeGraph(neighbors.data.data) : null) : null), [received, neighbors.data]);
  const truncation = overview.data && received ? truncationOf(overview.data.data.meta, received) : null;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<GraphView | null>(null);
  const [renderError, setRenderError] = useState<string | null>(gpu.renderer === null ? 'webgl2' : null);
  const selected = search.sel ?? search.focus;
  const selectRef = useRef((id: string | null) => { setSearch({ sel: id ?? undefined }); });
  selectRef.current = (id) => { setSearch({ sel: id ?? undefined }); };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || gpu.renderer === null) return;
    try {
      const v = new GraphView(host, gpu.profile, { onSelect: (id) => { selectRef.current(id); } });
      const lost = () => { setRenderError('context-lost'); };
      v.sigma.getWebGLContext().canvas.addEventListener('webglcontextlost', lost);
      setView(v);
      // Playwright only: a canvas has nothing else to aim at.
      if (navigator.webdriver) (window as unknown as { __loupeGraph?: GraphView }).__loupeGraph = v;
      return () => { v.sigma.getWebGLContext().canvas.removeEventListener('webglcontextlost', lost); setView(null); v.kill(); };
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, [gpu]);

  const [layoutNonce, setLayoutNonce] = useState(0);
  const scope = JSON.stringify([search.types, search.rtypes, search.domain, search.edge_status]);
  const { state: layout, revision } = useGraphLayout(view, data, scope, layoutNonce);

  useEffect(() => { if (view && revision > 0) view.select(selected ?? null); }, [view, selected, revision]);
  const focusedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!search.focus) focusedRef.current = undefined;
    if (!view || revision === 0 || !search.focus || focusedRef.current === search.focus || !view.graph.hasNode(search.focus)) return;
    focusedRef.current = search.focus;
    view.focusOn(search.focus);
  }, [view, revision, search.focus]);

  const past = useIsPastView();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const refreshOverview = useRefreshOverview();
  const newer = !past && !!env.meta && !!overview.data && env.meta.applied_seq > overview.data.applied_seq;
  const takeNewData = () => { void refreshOverview().then(() => { setLayoutNonce((x) => x + 1); }); };

  const typeFacets = useMemo(() => {
    const defaults = new Set(schema.data?.overview_types ?? []);
    return (facets.data?.facets.type ?? []).filter((f) => defaults.size === 0 || defaults.has(f.value));
  }, [facets.data, schema.data]);

  const counts = view && revision > 0 ? { nodes: view.graph.order, edges: view.graph.size } : null;
  return (
    <main
      className="graph-screen" data-testid="graph-screen" data-layout={layout.phase === 'ready' ? layout.kind : layout.phase === 'cold' ? 'computing' : layout.phase} data-source={layout.phase === 'ready' ? layout.source : undefined}
      data-placed={layout.phase === 'ready' ? layout.placed : undefined} data-profile={gpu.profile.name} data-nodes={counts?.nodes} data-edges={counts?.edges}
    >
      <FilterPanel
        schema={schema.data} typeFacets={typeFacets} domainFacets={facets.data?.facets.domain ?? []} types={search.types} rtypes={search.rtypes} domain={search.domain}
        superseded={search.edge_status === SUPERSEDED_EDGES} onTypes={(v) => { setSearch({ types: v }); }} onRtypes={(v) => { setSearch({ rtypes: v }); }} onDomain={(v) => { setSearch({ domain: v }); }}
        onSuperseded={(on) => { setSearch({ edge_status: on ? SUPERSEDED_EDGES : undefined }); }}
      />
      <section className="graph-stage" aria-label="그래프">
        <div ref={hostRef} className="graph-canvas" data-testid="graph-canvas" />
        <div className="graph-bands">
          {renderError && (
            <div role="alert" className="error-card" data-testid="graph-render-error">
              <p className="font-medium">그래프를 그릴 수 없다</p>
              <p className="mt-0.5 text-soft">{renderError === 'context-lost' ? 'GPU 컨텍스트를 잃었다. 페이지를 새로 고치면 다시 그린다.' : '이 브라우저에서 WebGL2를 쓸 수 없다. 전용 Chrome 창에서 연다.'}</p>
            </div>
          )}
          {overview.isPending && <Loading />}
          {overview.error && <ErrorCard compact={!!overview.data} error={overview.error} onRetry={() => void overview.refetch()} />}
          {layout.phase === 'cold' && <ColdProgress state={layout} />}
          {layout.phase === 'failed' && <div role="alert" className="error-card" data-testid="graph-layout-error"><p className="font-medium">레이아웃을 계산하지 못했다</p><p className="mt-0.5 text-soft">{layout.message}</p><Button className="mt-2" variant="outline" size="xs" data-testid="graph-layout-retry" onClick={() => { setLayoutNonce((x) => x + 1); }}>다시 시도</Button></div>}
          {newer && <div className="graph-band" data-testid="graph-new-data"><span>새 데이터가 있다.</span><Button variant="outline" size="xs" onClick={takeNewData}>다시 읽기</Button></div>}
          {search.merged_from && search.focus && <div className="graph-band" data-testid="graph-merged-notice"><span dir="auto">{fallbackLabel(search.merged_from)}은(는) 병합되어 이 노드로 왔다.</span></div>}
          {deadFocus && <div className="graph-band" data-testid="graph-focus-dead"><span>이 노드의 병합 경로를 따라갈 수 없다.</span>{search.focus && <NodeLink id={search.focus}>엔티티 페이지로</NodeLink>}</div>}
          {neighbors.error && <ErrorCard compact error={neighbors.error} onRetry={() => void neighbors.refetch()} />}
          {neighbors.data?.data.truncated && (
            <div className="graph-band" data-testid="graph-neighbors-truncated"><span>이웃 {n(neighbors.data.data.nodes.rows.length)} / {n(neighbors.data.data.node_total)}개만 펼쳤다.</span></div>
          )}
          {truncation?.any && (
            <div className="graph-band" data-testid="graph-truncated">
              <span data-testid="graph-truncated-text">
                {truncation.nodes && <>노드 {n(truncation.nodeRows)} / {n(truncation.nodeTotal)}</>}{truncation.nodes && truncation.edges && ' · '}
                {truncation.edges && <>엣지 {n(truncation.edgeRows)} / {n(truncation.edgeTotal)}</>}. 타입으로 좁히거나 이웃을 펼쳐 본다.
              </span>
              {allowed20k && !wanted20k && <Button variant="outline" size="xs" data-testid="graph-wide" onClick={() => { setSearch({ view: '20k' }); }}>2만 보기</Button>}
            </div>
          )}
          {wanted20k && allowed20k && !confirmedWide && (
            <div className="graph-band" role="alertdialog" aria-label="2만 보기 경고" data-testid="graph-wide-warning">
              <span>2만 보기는 첫 프레임이 1.6초까지 걸릴 수 있고 호버가 끊길 수 있다.</span>
              <Button variant="outline" size="xs" data-testid="graph-wide-confirm" onClick={() => { setConfirmedWide(true); }}>계속</Button>
              <Button variant="ghost" size="xs" data-testid="graph-wide-cancel" onClick={() => { setSearch({ view: undefined }); }}>취소</Button>
            </div>
          )}
          {wanted20k && !allowed20k && <div className="graph-band" data-testid="graph-wide-blocked"><span>이 GPU에서는 2만 보기를 쓰지 않는다. 기본 범위로 보여 준다.</span></div>}
        </div>
        <div className="graph-corner">
          <TimeMark />
          {gpu.profile.name === 'radeon' && <Chip data-testid="graph-radeon">Radeon 프로필</Chip>}
          <Button variant="outline" size="xs" data-testid="graph-fit" onClick={() => view?.fit()}>맞추기</Button>
        </div>
      </section>
      {selected && data && <SelectionPanel id={selected} data={data} onClose={() => { setSearch({ sel: undefined, focus: undefined, depth: undefined, merged_from: undefined }); }} />}
    </main>
  );
}
