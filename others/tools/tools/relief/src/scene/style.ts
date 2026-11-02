// Colours and overlay rules (design 9.3, 9.10). Every colour here names a token of styles.css. Basis marks (dashes, stripes, hollow) are drawn whatever the overlay says.
import { ageS, type Basis, type Entity, type Kind, type State } from '../../server/model/fact.ts';

export type Overlay = 'state' | 'load' | 'basis' | 'fresh';
export type Metric = 'cpu' | 'mem' | 'disk';

export const OVERLAYS: { id: Overlay; label: string }[] = [{ id: 'state', label: '상태' }, { id: 'load', label: '부하' }, { id: 'basis', label: '근거' }, { id: 'fresh', label: '신선도' }];
export const METRICS: { id: Metric; label: string }[] = [{ id: 'cpu', label: 'CPU' }, { id: 'mem', label: '메모리' }, { id: 'disk', label: '디스크' }];

/** A material is three tokens, one per face of the light: `--m-<name>-t`, `-l`, `-r` (top, left, right). */
export type Tone = 't' | 'l' | 'r';
export const paint = (material: string, tone: Tone) => `var(--m-${material}-${tone})`;

export const HOLLOW = 'var(--hollow)';
export const STRIPES = 'url(#declared)';
export const LINE = { select: 'var(--select)', warn: 'var(--st-critical)', hollow: 'var(--hollow-line)', rim: 'var(--rim)' } as const;

/** Healthy things stay quiet: what is merely working wears a low-chroma material, and only a state or an alert brings colour. */
export const KIND_MATERIAL: Record<Kind | 'dockerhost', string> = {
  wan: 'edge', modem: 'edge', domain: 'edge', gateway: 'edge', tunnel: 'edge', proxy: 'edge', switch: 'edge', wifi: 'edge', clients: 'edge',
  segment: 'seg', node: 'slab', workstation: 'slab', bmc: 'gear', bridge: 'gear', storage: 'store', vm: 'vm', lxc: 'lxc', container: 'ctr', dockerhost: 'host',
};
export const STATE_MATERIAL: Partial<Record<State, string>> = { stopped: 'stopped', error: 'error', creating: 'busy', starting: 'busy', stopping: 'busy', migrating: 'move' };
export const BASIS_MATERIAL: Record<Basis, string> = { observed: 'b-observed', derived: 'b-derived', declared: 'b-declared', unknown: 'neutral' };
export const NEUTRAL = 'neutral';

export const STATE_LABEL: Record<State, string> = { running: '실행', stopped: '중지', creating: '생성 중', starting: '기동 중', stopping: '중지 중', migrating: '이동 중', error: '오류', ok: '', unknown: '미확인' };

export function loadColor(v: number): string { return v < 0.6 ? 'var(--load-low)' : v < 0.85 ? 'var(--load-mid)' : 'var(--load-high)'; }

export function freshMaterial(e: Entity, nowMs: number): string {
  let worst = -1;
  for (const f of Object.values(e.facts)) {
    if (f.basis !== 'observed' || f.ttlS == null) continue;
    const a = ageS(f.at, nowMs);
    worst = Math.max(worst, a == null ? 9 : a / f.ttlS);
  }
  if (worst < 0) return NEUTRAL;
  return worst <= 0.34 ? 'f1' : worst <= 1 ? 'f2' : 'f3';
}

export function metricOf(e: Entity, m: Metric): number | null {
  const f = e.facts[m] ?? (m === 'disk' ? e.facts.disk : undefined);
  return f && f.basis === 'observed' && typeof f.value === 'number' ? f.value : null;
}
