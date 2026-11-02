// The one place that says how something is (design 9.14). The pill, the menu, the modal, the list, the map and the links read this and work nothing out for themselves.
// "Healthy" is a claim, so it needs evidence: every required check has a fresh value and none is over its limit. No warnings is not evidence.
// Required is per kind. What a kind cannot give (a QEMU disk, Docker on a guest) is not applicable: it neither counts for nor against. Missing is something that should be there and is not.
import { ageS, BASIS_LABEL, freshness, staleIds, type Alert, type Entity, type Kind, type Limits, type Relation, type Snapshot } from './fact.ts';
import { ABOVE, CHECK_KEY, type Metric } from './threshold.ts';

export type Health = 'problem' | 'warning' | 'stale' | 'unknown' | 'healthy';
export type ObjectHealth = {
  state: Health; word: string; stale: boolean;
  /** Has required checks at all. A declared router is not observed, so it has no verdict of its own. */
  monitored: boolean;
  required: number; met: number; missing: string[]; notApplicable: string[];
  alerts: Alert[]; drift: string[]; pending: string[];
  /** What the object is doing, as a word, when that is not simply "up". */
  life: string; busy: boolean;
};
export type Finding = { level: 'problem' | 'warn' | 'stale'; title: string; why: string; id?: string };
export type SystemHealth = { state: Health; text: string; problems: number; warnings: number; stale: number; blanks: number; required: number; met: number; notApplicable: number; lastAt: string | null; findings: Finding[] };
export type HealthMap = { objects: Map<string, ObjectHealth>; system: SystemHealth };
export type LinkState = 'healthy' | 'warning' | 'down' | 'stale' | 'unknown';

/** The state fact is required of each of these, as are the metrics listed. Everything else on the map has nothing to measure. */
const REQUIRED: Partial<Record<Kind, readonly Metric[]>> = { node: ['cpu', 'mem', 'disk'], vm: ['cpu', 'mem', 'disk'], lxc: ['cpu', 'mem', 'disk'], storage: ['disk'], bridge: [], container: [] };
const LABEL: Record<Metric, string> = { cpu: 'CPU', mem: '메모리', disk: '디스크' };
const GUEST = new Set<Kind>(['vm', 'lxc']);
const LIFECYCLE: Partial<Record<Entity['state'], string>> = { stopped: '중지', creating: '생성 중', starting: '기동 중', stopping: '중지 중', migrating: '이동 중' };
const BUSY = new Set<Entity['state']>(['creating', 'starting', 'stopping']);
const WORD: Record<Health, string> = { problem: '문제', warning: '경고', stale: '낡음', unknown: '미확인', healthy: '정상' };

/** Older than this the screen is showing the past: a live map publishes at least once a minute. */
export const SCREEN_MAX_S = 180;

/** A blank this kind was never going to fill: the same answer for the verdict, the list of blanks and the value rows. */
export const notApplicable = (e: Entity, key: string) => e.facts[key]?.basis === 'unknown' && ((e.kind === 'vm' && key === 'disk') || (GUEST.has(e.kind) && key === 'docker'));

export function objectHealth(e: Entity, ctx: { stale: boolean; limits?: Limits | undefined; nowMs: number }): ObjectHealth {
  const metrics = REQUIRED[e.kind];
  const monitored = metrics !== undefined && e.basis === 'observed' && !e.gone;
  const out: ObjectHealth = { state: 'unknown', word: '', stale: ctx.stale, monitored, required: 0, met: 0, missing: [], notApplicable: [], alerts: e.alerts ?? [], drift: e.warnings ?? [], pending: [], life: e.state === 'error' ? '오류' : LIFECYCLE[e.state] ?? '', busy: BUSY.has(e.state) };
  let stale = ctx.stale;
  const fresh = (f: Entity['facts'][string] | undefined) => { if (f && freshness(f, ctx.nowMs) === 'stale') { stale = true; return false; } return true; };

  if (monitored) {
    out.required += 1;
    const st = e.facts.state;
    if (st?.basis === 'observed' && e.state !== 'unknown') { if (fresh(st)) out.met += 1; } else out.missing.push('상태');
    const off = GUEST.has(e.kind) && (e.state === 'stopped' || e.state === 'creating');
    for (const m of metrics) {
      const value = e.facts[m]; const check = e.facts[CHECK_KEY[m]];
      if (off) { out.notApplicable.push(LABEL[m]); continue; }
      if (notApplicable(e, m)) { out.notApplicable.push(LABEL[m]); continue; } // PVE does not report it for QEMU.
      out.required += 1;
      if (!fresh(value)) continue;
      if (!check || check.basis === 'unknown') {
        out.missing.push(LABEL[m]);
        const limit = ctx.limits?.[m];
        if (typeof value?.value === 'number' && value.basis === 'observed' && limit !== undefined && value.value >= limit) out.pending.push(`${LABEL[m]} ${Math.round(value.value * 100)}% · 지속 확인 중`);
        continue;
      }
      out.met += 1;
      const limit = ctx.limits?.[m];
      if (typeof value?.value === 'number' && limit !== undefined && value.value >= limit && !String(check.value).startsWith(ABOVE)) out.pending.push(`${LABEL[m]} ${Math.round(value.value * 100)}% · 지속 확인 중`);
    }
    if (notApplicable(e, 'docker')) out.notApplicable.push('Docker');
  }
  for (const c of e.services ?? []) {
    out.required += 1;
    if (c.status.basis !== 'observed') out.missing.push(c.title);
    else if (fresh(c.status)) out.met += 1;
  }

  const problem = e.state === 'error' || out.alerts.some((a) => a.level === 'problem');
  const warning = out.alerts.length > 0 || out.drift.length > 0 || out.pending.length > 0 || (e.kind === 'bridge' && e.state === 'stopped');
  const complete = out.required > 0 && out.met === out.required && out.missing.length === 0;
  out.state = problem ? 'problem' : warning ? 'warning' : stale ? 'stale' : complete ? 'healthy' : 'unknown';
  out.stale = stale;
  const life = LIFECYCLE[e.state];
  out.word = e.gone ? '사라짐' : out.state === 'problem' || out.state === 'warning' || out.state === 'stale' ? WORD[out.state] : life ?? (monitored || out.required ? WORD[out.state] : e.basis === 'observed' ? BASIS_LABEL.observed : BASIS_LABEL[e.basis]);
  return out;
}

/** What one end says about a link. A segment says nothing: it is a name for bridges, so the other end and the bridge decide. */
function endLink(n: Entity | undefined, h: ObjectHealth | undefined): LinkState | null {
  if (!n || !h) return 'unknown';
  if (n.kind === 'segment' && !n.gone) return null;
  if (n.gone || n.state === 'stopped' || n.state === 'stopping' || h.state === 'problem') return 'down';
  if (h.stale) return 'stale';
  return h.state === 'warning' ? 'warning' : h.state === 'healthy' ? 'healthy' : 'unknown';
}
const LINK_ORDER: LinkState[] = ['down', 'stale', 'unknown', 'warning', 'healthy'];

/** A link is as good as its worst end, and healthy only if its ends are. An end with no verdict makes the link unknown. */
export function linkState(e: Relation, byId: ReadonlyMap<string, Entity>, health: ReadonlyMap<string, ObjectHealth>): LinkState {
  if (e.basis === 'unknown') return 'unknown';
  const via = e.facts.via?.value;
  const ends = [e.source, e.target, ...(typeof via === 'string' ? [via] : [])].map((id) => endLink(byId.get(id), health.get(id)));
  return LINK_ORDER.find((s) => ends.includes(s)) ?? 'unknown';
}

/** The short wire from a slab's edge to its bridge has one end that matters. */
export const wireState = (n: Entity, h: ObjectHealth | undefined): LinkState => endLink(n, h) ?? 'unknown';

const SOURCE_OF: [RegExp, string][] = [[/^pve:/, 'pve'], [/^wan-ip:/, 'wan-ip'], [/^health:/, 'health'], [/^docker:/, 'docker']];
const SOURCE_NAME: Record<string, string> = { pve: 'Proxmox', edge: 'edge.json', 'wan-ip': '공인 IP', docker: 'Docker', health: '서비스 검사', store: '상태 저장', watch: '기억' };
const RANK: Record<Finding['level'], number> = { problem: 0, warn: 1, stale: 2 };

/** Everything on one snapshot. A surface asks this and reads the answer: it never looks at an alert, a warning or a blank itself. */
export function healthOf(s: Pick<Snapshot, 'nodes' | 'sources' | 'takenAt' | 'limits' | 'missing' | 'unplaced'>, nowMs: number, o: { offline?: boolean } = {}): HealthMap {
  const stale = staleIds(s, nowMs);
  const objects = new Map(s.nodes.map((e) => [e.id, objectHealth(e, { stale: stale.has(e.id), limits: s.limits, nowMs })]));
  const findings: Finding[] = [];
  let required = 0; let met = 0; let blanks = 0; let notApplicable = 0;
  for (const e of s.nodes) {
    if (e.gone) continue;
    const h = objects.get(e.id)!;
    required += h.required; met += h.met; blanks += h.missing.length; notApplicable += h.notApplicable.length;
    if (e.state === 'error') findings.push({ level: 'problem', title: e.title, why: '오류', id: e.id });
    for (const a of h.alerts) findings.push({ level: a.level, title: e.title, why: a.text, id: e.id });
    for (const w of h.drift) findings.push({ level: 'warn', title: e.title, why: w, id: e.id });
    for (const p of h.pending) findings.push({ level: 'warn', title: e.title, why: p, id: e.id });
  }
  // What cannot be drawn still counts: an object that went away, a check with nowhere to stand.
  for (const m of s.missing ?? []) findings.push({ level: 'problem', title: m.title, why: '사라짐' });
  for (const c of s.unplaced ?? []) {
    required += 1;
    if (c.status.basis !== 'observed') blanks += 1; else met += 1;
    if (c.status.value === 'down') findings.push({ level: 'problem', title: c.title, why: '서비스 응답 없음' });
  }
  const staleSources = new Set(s.sources.filter((x) => x.state === 'failing').map((x) => x.id));
  // A read the source needs and did not get: its values stay, and nothing may be called healthy on them.
  for (const x of s.sources) for (const p of x.partial ?? []) findings.push({ level: 'stale', title: `${SOURCE_NAME[x.id] ?? x.id} ${p.name}`, why: p.why });
  for (const e of s.nodes) {
    for (const f of Object.values(e.facts)) if (freshness(f, nowMs) === 'stale') { const hit = SOURCE_OF.find(([re]) => re.test(f.source)); if (hit) staleSources.add(hit[1]); }
    for (const c of e.services ?? []) if (freshness(c.status, nowMs) === 'stale') staleSources.add('health');
  }
  for (const id of staleSources) { const x = s.sources.find((y) => y.id === id); findings.push({ level: 'stale', title: SOURCE_NAME[id] ?? id, why: x?.why ?? '값이 낡았다' }); }
  findings.sort((a, b) => RANK[a.level] - RANK[b.level]);

  const partial = s.sources.reduce((n, x) => n + (x.partial?.length ?? 0), 0);
  const problems = findings.filter((f) => f.level === 'problem').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  const pve = s.sources.find((x) => x.id === 'pve');
  const oldScreen = (ageS(s.takenAt, nowMs) ?? Infinity) > SCREEN_MAX_S;
  const noRead = !pve || pve.state === 'none' || pve.at === null;
  const complete = required > 0 && met === required && blanks === 0;
  const state: Health = o.offline || oldScreen ? 'stale' : noRead ? 'unknown' : problems ? 'problem' : warnings ? 'warning' : staleSources.size + partial ? 'stale' : complete ? 'healthy' : 'unknown';
  const text = o.offline ? '연결 끊김' : oldScreen ? '낡은 화면' : noRead ? (pve?.state === 'pending' ? '첫 수집 대기' : '확인 불가')
    : { problem: `문제 ${problems}`, warning: `경고 ${warnings}`, stale: `낡음 ${staleSources.size + partial}`, unknown: `미확인 ${required - met}/${required}`, healthy: '이상 없음' }[state];
  const lastAt = s.sources.flatMap((x) => (x.id !== 'edge' && x.at?.includes('T') ? [x.at] : [])).sort().at(-1) ?? null;
  return { objects, system: { state, text, problems, warnings, stale: staleSources.size + partial, blanks, required, met, notApplicable, lastAt, findings } };
}
