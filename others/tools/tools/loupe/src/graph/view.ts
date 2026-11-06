// sigma 4 driven directly, not through @react-sigma/core: this is the only path that was measured (design 6.1). The screen knows this class and
// nothing about sigma. Label text lives in the `l` attribute, never `label`: first frame 1.9 s to 0.5 s and heap 165 to 63 MB.
import { MultiDirectedGraph } from 'graphology';
import Sigma, { DEFAULT_STYLES } from 'sigma';
import { layerDashed } from 'sigma/rendering';
import { degrees, drawnEdges, nodeSize, type GraphData } from './model.ts';
import type { GraphProfile } from './gpuProfile.ts';
import type { Positions } from './layoutFlow.ts';
import { LabelOverlay } from './overlay.ts';

const EDGE_COLOR = '#d3d7de', EDGE_ACCENT = '#d6336c', DIMMED = '#e4e6ea', NO_COMMUNITY = '#9aa3af';
const COMMUNITY_COLORS = ['#4c78a8', '#f58518', '#54a24b', '#b279a2', '#e45756', '#72b7b2', '#9d755d', '#bab0ac', '#eeca3b', '#ff9da6', '#7f7f7f', '#2f7ed8'];
export const communityColor = (c: number) => (c < 0 ? NO_COMMUNITY : COMMUNITY_COLORS[c % COMMUNITY_COLORS.length]!);

type NodeAttrs = { x: number; y: number; size: number; color: string; l: string };
type EdgeAttrs = { size: number; color: string; dashLen: number; merged: boolean };
type Reduced = Record<string, unknown>;
export type ViewEvents = { onSelect(id: string | null): void };

const extent = (positions: Positions) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { x: [minX, maxX] as [number, number], y: [minY, maxY] as [number, number] } : null;
};

export class GraphView {
  readonly graph = new MultiDirectedGraph<NodeAttrs, EdgeAttrs>();
  readonly sigma: Sigma<NodeAttrs, EdgeAttrs>;
  readonly overlay: LabelOverlay;
  private hover: string | null = null;
  private hoverNbrs = new Set<string>();
  private hoverEdges = new Set<string>();
  private selected: string | null = null;
  private selectedNbrs = new Set<string>();
  private readonly observer: ResizeObserver;
  private readonly host: HTMLElement;

  constructor(host: HTMLElement, profile: GraphProfile, events: ViewEvents) {
    this.host = host;
    const edgeStyles = { ...DEFAULT_STYLES.edges, dashLen: { attribute: 'dashLen' } };
    const options = {
      settings: {
        renderLabels: false, renderEdgeLabels: false, enableCameraRotation: false,
        hideEdgesOnMove: profile.hideEdgesOnMove, antialiasEdges: profile.antialiasEdges,
      },
      nodeReducer: (key: string, data: Reduced) => this.reduceNode(key, data),
      edgeReducer: (key: string, data: Reduced) => this.reduceEdge(key, data),
      // gapSize 0 turns solid edges transparent, and dashLen 1e6 is how a solid edge is drawn (design 6.1).
      primitives: { edges: { layers: [layerDashed({ dashSize: { attribute: 'dashLen', default: 5, mode: 'pixels' }, gapSize: { value: 5, mode: 'pixels' } })] } },
      styles: { nodes: DEFAULT_STYLES.nodes, edges: edgeStyles },
    };
    this.sigma = new Sigma<NodeAttrs, EdgeAttrs>(this.graph, host, options as never);
    this.overlay = new LabelOverlay(this.sigma, host, profile);
    this.sigma.on('afterRender', () => { this.overlay.draw(); });
    this.sigma.on('enterNode', ({ node }) => { this.setHover(node); });
    this.sigma.on('leaveNode', () => { this.setHover(null); });
    this.sigma.on('clickNode', ({ node }) => { events.onSelect(node); });
    this.sigma.on('clickStage', () => { events.onSelect(null); });
    this.observer = new ResizeObserver(() => { this.overlay.resize(); this.overlay.draw(); });
    this.observer.observe(host);
  }

  private reduceNode(key: string, d: Reduced): Reduced {
    let out = d;
    // Dimming is for a click only: 281 ms against 7 ms for neighbours-only (design 6.1).
    if (this.selected && key !== this.selected && !this.selectedNbrs.has(key)) out = { ...out, color: DIMMED };
    if (this.hover && (key === this.hover || this.hoverNbrs.has(key))) out = { ...out, zIndex: 2, size: (d.size as number) * 1.3 };
    return out;
  }

  private reduceEdge(key: string, d: Reduced): Reduced {
    if (d.merged) return { ...d, visibility: 'hidden' };
    if (this.hoverEdges.has(key)) return { ...d, color: EDGE_ACCENT, size: 1.2, zIndex: 2 };
    if (this.selected) {
      const [a, b] = this.graph.extremities(key);
      if (a !== this.selected && b !== this.selected) return { ...d, visibility: 'hidden' };
    }
    return d;
  }

  /** Everything on the canvas comes from `g`. The frame comes from `positions`, all of them, so a filter does not move what stays (design 6.2). */
  setData(g: GraphData, positions: Positions) {
    const { graph, sigma } = this;
    this.clearHover();
    graph.clear();
    const edges = drawnEdges(g), degree = degrees(edges);
    const n = g.nodes.length;
    const keys: string[] = [], labels: string[] = [];
    const xs = new Float32Array(n), ys = new Float32Array(n), sizes = new Float32Array(n);
    let i = 0;
    for (const node of g.nodes) {
      const p = positions.get(node.id);
      if (!p) continue;
      const size = nodeSize(degree.get(node.id) ?? 0);
      graph.addNode(node.id, { x: p.x, y: p.y, size, color: communityColor(p.community), l: node.label });
      keys.push(node.id); labels.push(node.label); xs[i] = p.x; ys[i] = p.y; sizes[i] = size; i++;
    }
    for (const e of edges) {
      if (!graph.hasNode(e.src) || !graph.hasNode(e.dst)) continue;
      graph.addDirectedEdgeWithKey(e.id, e.src, e.dst, { size: 0.5, color: EDGE_COLOR, dashLen: e.dashed ? 5 : 1e6, merged: !e.drawn });
    }
    const box = extent(positions);
    if (box) sigma.setCustomBBox(box);
    this.overlay.setNodes({ keys, labels, xs: xs.subarray(0, i), ys: ys.subarray(0, i), sizes: sizes.subarray(0, i) });
    this.refreshSelection();
    sigma.refresh();
  }

  /** The one swap at the end of a cold layout. */
  setPositions(positions: Positions) {
    const { graph, sigma } = this;
    graph.updateEachNodeAttributes((key, a) => {
      const p = positions.get(key);
      return p ? { ...a, x: p.x, y: p.y, color: communityColor(p.community) } : a;
    }, { attributes: ['x', 'y', 'color'] });
    const keys = graph.nodes();
    const xs = Float32Array.from(keys, (k) => graph.getNodeAttribute(k, 'x')), ys = Float32Array.from(keys, (k) => graph.getNodeAttribute(k, 'y'));
    this.overlay.setPositions(keys, xs, ys);
    const box = extent(positions);
    if (box) sigma.setCustomBBox(box);
    sigma.refresh();
  }

  private clearHover() { this.hover = null; this.hoverNbrs = new Set(); this.hoverEdges = new Set(); this.overlay.setHover([]); }

  setHover(key: string | null) {
    const { graph, sigma } = this;
    const nodes = this.hover ? [this.hover, ...this.hoverNbrs] : [], edges = [...this.hoverEdges];
    this.hover = key;
    this.hoverNbrs = new Set(key ? graph.neighbors(key) : []);
    this.hoverEdges = new Set(key ? graph.edges(key) : []);
    this.overlay.setHover(key ? [key, ...this.hoverNbrs] : []);
    sigma.refresh({ partialGraph: { nodes: [...nodes, ...(key ? [key] : []), ...this.hoverNbrs], edges: [...edges, ...this.hoverEdges] }, skipIndexation: true });
  }

  private refreshSelection() {
    const has = this.selected !== null && this.graph.hasNode(this.selected);
    if (!has) this.selected = null;
    this.selectedNbrs = new Set(has ? this.graph.neighbors(this.selected!) : []);
  }

  select(id: string | null) {
    if (id === this.selected) return;
    this.selected = id;
    this.refreshSelection();
    this.sigma.refresh({ skipIndexation: true });
  }

  focusOn(id: string) {
    const d = this.sigma.getNodeDisplayData(id);
    if (d) void this.sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.35 }, { duration: 300 });
  }

  fit() { void this.sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 200 }); }

  /** Viewport position of a node. Tests and the bench use it to aim. */
  viewportOf(id: string) {
    const { x, y } = this.graph.getNodeAttributes(id);
    return this.sigma.graphToViewport({ x, y });
  }

  kill() {
    this.observer.disconnect();
    this.overlay.remove();
    this.sigma.kill();
    this.host.replaceChildren();
  }
}
