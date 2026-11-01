// View state lives in the URL hash (design 9.4): `#/?mode=iso&overlay=load&sel=pve:qemu:100`. A copied link opens the same screen.
import type { Mode } from './scene/project.ts';
import type { Metric, Overlay } from './scene/style.ts';

export type View = { mode: Mode; overlay: Overlay; metric: Metric; sel: string | null; open: boolean; fx: 'today' | 'large' | 'scale'; q: string };
export const DEFAULT_VIEW: View = { mode: 'iso', overlay: 'state', metric: 'cpu', sel: null, open: false, fx: 'today', q: '' };

const pick = <T extends string>(v: string | null, all: readonly T[], d: T): T => (v !== null && (all as readonly string[]).includes(v) ? (v as T) : d);

export function parseHash(hash: string): View {
  const i = hash.indexOf('?');
  const p = new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
  const sel = p.get('sel');
  return {
    mode: pick(p.get('mode'), ['iso', '2d'], DEFAULT_VIEW.mode),
    overlay: pick(p.get('overlay'), ['state', 'load', 'basis', 'fresh'], DEFAULT_VIEW.overlay),
    metric: pick(p.get('metric'), ['cpu', 'mem', 'disk'], DEFAULT_VIEW.metric),
    sel: sel && sel.length < 200 ? sel : null,
    open: p.get('open') === '1' && !!sel,
    fx: pick(p.get('fx'), ['today', 'large', 'scale'], DEFAULT_VIEW.fx),
    q: (p.get('q') ?? '').slice(0, 80).normalize('NFC'),
  };
}

/** Only values that differ from the default are written, so the common link stays short. */
export function formatHash(v: View): string {
  const p = new URLSearchParams();
  if (v.mode !== DEFAULT_VIEW.mode) p.set('mode', v.mode);
  if (v.overlay !== DEFAULT_VIEW.overlay) p.set('overlay', v.overlay);
  if (v.overlay === 'load' && v.metric !== DEFAULT_VIEW.metric) p.set('metric', v.metric);
  if (v.sel) p.set('sel', v.sel);
  if (v.sel && v.open) p.set('open', '1');
  if (v.fx !== DEFAULT_VIEW.fx) p.set('fx', v.fx);
  if (v.q) p.set('q', v.q);
  const s = p.toString().replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  return `#/${s ? `?${s}` : ''}`;
}
