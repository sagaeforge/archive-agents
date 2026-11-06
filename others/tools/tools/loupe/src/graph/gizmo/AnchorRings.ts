// The dashed ring of a topic anchor (design v2 2.3). sigma has no dashed node outline, so a Canvas 2D sheet over it draws one per anchor.
import type { GraphView } from '../view.ts';

export class AnchorRings {
  readonly canvas: HTMLCanvasElement;
  private ids: string[] = [];
  private readonly ctx: CanvasRenderingContext2D;
  private readonly off: () => void;
  private readonly view: GraphView;

  constructor(view: GraphView, host: HTMLElement) {
    this.view = view;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    this.canvas.dataset.testid = 'graph-anchors';
    this.canvas.dataset.anchors = '';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const draw = () => { this.draw(); };
    view.sigma.on('afterRender', draw);
    this.off = () => { view.sigma.off('afterRender', draw); };
  }

  set(ids: string[]) { this.ids = ids; this.canvas.dataset.anchors = ids.join(','); this.draw(); }

  draw() {
    const { canvas, ctx, view } = this;
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#5b6573'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    for (const id of this.ids) {
      if (!view.graph.hasNode(id)) continue;
      const p = view.viewportOf(id), r = view.sigma.scaleSize(view.graph.getNodeAttribute(id, 'size')) + 4;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  kill() { this.off(); this.canvas.remove(); }
}
