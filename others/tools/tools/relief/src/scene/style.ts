// Colours and overlay rules (design 9.3). Basis marks (dashes, stripes, hollow) are drawn whatever the overlay says.
import { ageS, type Basis, type Entity, type Kind, type State } from '../../server/model/fact.ts';

export type Overlay = 'state' | 'load' | 'basis' | 'fresh';
export type Metric = 'cpu' | 'mem' | 'disk';

export const OVERLAYS: { id: Overlay; label: string }[] = [{ id: 'state', label: '상태' }, { id: 'load', label: '부하' }, { id: 'basis', label: '근거' }, { id: 'fresh', label: '신선도' }];
export const METRICS: { id: Metric; label: string }[] = [{ id: 'cpu', label: 'CPU' }, { id: 'mem', label: '메모리' }, { id: 'disk', label: '디스크' }];

export const KIND_COLOR: Record<Kind | 'dockerhost', string> = {
  wan: '#dd7f33', modem: '#dd7f33', domain: '#dd7f33', gateway: '#dd7f33', tunnel: '#dd7f33', proxy: '#dd7f33', switch: '#dd7f33', wifi: '#dd7f33', clients: '#dd7f33',
  segment: '#3f9b6c', node: '#d8dee8', workstation: '#d8dee8', bmc: '#6b7a90', bridge: '#6b7a90', storage: '#b99558', vm: '#4a78e0', lxc: '#2ba193', container: '#8a68d4', dockerhost: '#7f9fea',
};
export const STATE_COLOR: Partial<Record<State, string>> = { stopped: '#a9b0bb', error: '#d9483b', creating: '#e9a820', starting: '#e9a820', stopping: '#e9a820', migrating: '#8a68d4' };
export const BASIS_COLOR: Record<Basis, string> = { observed: '#4a78e0', derived: '#3f9b6c', declared: '#dd7f33', unknown: '#ffffff' };
export const NEUTRAL = '#d5dbe6';

export const STATE_LABEL: Record<State, string> = { running: '실행', stopped: '중지', creating: '생성 중', starting: '기동 중', stopping: '중지 중', migrating: '이동 중', error: '오류', ok: '', unknown: '미확인' };

export function loadColor(v: number): string { return v < 0.6 ? '#3f9b6c' : v < 0.85 ? '#e9a820' : '#d9483b'; }

export function freshColor(e: Entity, nowMs: number): string {
  let worst = -1;
  for (const f of Object.values(e.facts)) {
    if (f.basis !== 'observed' || f.ttlS == null) continue;
    const a = ageS(f.at, nowMs);
    worst = Math.max(worst, a == null ? 9 : a / f.ttlS);
  }
  if (worst < 0) return NEUTRAL;
  return worst <= 0.34 ? '#3f9b6c' : worst <= 1 ? '#9bbf4a' : '#d9893b';
}

export function metricOf(e: Entity, m: Metric): number | null {
  const f = e.facts[m] ?? (m === 'disk' ? e.facts.disk : undefined);
  return f && f.basis === 'observed' && typeof f.value === 'number' ? f.value : null;
}
