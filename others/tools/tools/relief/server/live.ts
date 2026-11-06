// The live map: three loops feed `Raw`, every result is normalised, compared and served. Failure paths are here (design 6.6): a failed read leaves `Raw` alone.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop, type Loop, type ReadAdapter } from './collect/adapter.ts';
import { readEdge, type EdgeFile, type EdgeRead } from './collect/edge.ts';
import { applyServices, runChecks, targetsOf, tcpProbe, unplacedServices, type Probe, type Reading, type Target } from './collect/health.ts';
import type { Reader } from './collect/mcp.ts';
import { isSource, readFast, readGuest, readMetrics, readSlow, validId, validNode, whyOf, type FastRead, type GuestRead, type GuestRef, type MetricRead, type MetricValues, type SlowRead, type Tried } from './collect/pve.ts';
import { readTrend, type Trend, type TrendRef } from './collect/trend.ts';
import { readPublicIp } from './collect/wanip.ts';
import { readChanges, type ChangePage, type ChangeQuery } from './changes.ts';
import type { Timeframe } from './collect/allowlist.ts';
import { layoutSnapshot } from './layout/elk.ts';
import { diff, hashesOf, isEmpty, type Hashes, type StateMap } from './model/diff.ts';
import type { Entity, Limits, Relation, Snapshot, SourceStatus } from './model/fact.ts';
import { applyRates, Rates } from './model/rate.ts';
import { advance, applyWatch, emptyWatch, forget, parseWatch, type Watch } from './model/watch.ts';
import { consumeRequests, type Reply } from './forget.ts';
import { applyChecks, DEFAULT_LIMITS, Samples, type Verdicts } from './model/threshold.ts';
import type { LocalRead } from './collect/local.ts';
import type { WanRead } from './model/edgemap.ts';
import { activeTask, emptyRaw, guestKey, isGuest, normalize, type Part, type Raw } from './model/normalize.ts';

// activeS + the browser's 5 s must stay inside the 10 s budget of design 13.
export const PERIOD = { fastS: 15, activeS: 4, idleS: 60, largeS: 30, slowS: 300, guestS: 600, guestFailS: 1800, guestTickS: 20, metricsS: 15, viewerGoneS: 120, overlayGoneS: 30, minTtlS: 45, edgeS: 10, wanS: 600, healthS: 60, forgetS: 2 };
/** How long a damaged memory stays on the status bar. Long enough to be seen: it cannot be repaired, only rebuilt. */
export const WATCH_LOST_S = 600;
const WATCH_LOST = '기억 손상 · 버리고 다시 쌓는 중';
/** A trend is read when a panel asks, then held this long (design 8). */
export const TREND_CACHE_S: Record<Timeframe, number> = { hour: 60, day: 300 };
const TREND_KEEP = 32;
/** One open page must not be able to hammer PVE (design 8): reads a minute across all panels, reads at once, and how long a failed object rests. */
export const TREND_LIMIT = { perMin: 12, inFlight: 2, backoffS: 30, backoffMaxS: 300 };
const BUSY = '요청이 많다 · 잠시 뒤 다시';
export const CHANGES_MAX = 5000;
const WAITING = '첫 수집 대기';
const GUEST_CONCURRENCY = 2;
const LARGE_GUESTS = 200;

export type LiveOptions = {
  reader: Reader; stateDir: string; period?: Partial<typeof PERIOD>;
  /** A configuration fault found before the first read. Shown on the source, and nothing is read. */
  fault?: string | undefined;
  /** Absent: the source is `none`, and nothing is read. */
  edgePath?: string | undefined;
  /** Absent: `wan-ip` is off and relief makes no outside call at all. There is no default. */
  wanUrl?: string | undefined;
  /** A `publicIpUrl` that failed its check. It fails this one source and nothing else. */
  wanFault?: string | undefined;
  local?: (nowMs: number) => LocalRead | null;
  now?: () => number;
  /** The limits of `relief.json`, or the defaults. */
  limits?: Limits | undefined;
  /** Tests stand in here. Nothing is called while edge.json lists no services. */
  probe?: Probe;
};

export type Served = { snapshot: Snapshot; etag: string };
export type LiveStatus = { seq: number; sources: SourceStatus[]; calls: Reader['record']; lastRead: string | null; missing: { id: string; title: string; since: string }[] };

type Persisted = { schema: 1; seq: number; raw: Raw; slots: Record<string, number>; nextSlot: number; wan?: WanRead | null; watch?: unknown };

export class Live {
  private o: LiveOptions;
  private p: typeof PERIOD;
  private limits: Limits;
  private now: () => number;
  private raw: Raw = emptyRaw();
  private seq = 0;
  private rev = 0;
  private slots: Record<string, number> = {};
  private nextSlot = 0;
  private nodes: Entity[] = [];
  private edges: Relation[] = [];
  private hashes: Hashes = {};
  private states: StateMap = {};
  private layout: Pick<Snapshot, 'layout' | 'routes'> = { layout: {}, routes: {} };
  private topology = '';
  private source: SourceStatus = { id: 'pve', state: 'pending', count: null, at: null, why: WAITING };
  private served: Snapshot | null = null;
  private metrics: { at: string | null; values: MetricValues } = { at: null, values: {} };
  private loops: Loop[] = [];
  private fastLoop: Loop | null = null;
  private guestLoop: Loop | null = null;
  private slowLoop: Loop | null = null;
  private metricsLoop: Loop | null = null;
  private baseline = true;
  private restored = false;
  private prepared = false;
  private lastViewer = -Infinity;
  private lastOverlay = -Infinity;
  private guestDue = new Map<string, number>();
  private guestStatus = new Map<string, string>();
  private savedAt = 0;
  private dirty = false;
  private changeLines = 0;
  private lineNo = 0;
  private commits: Promise<void> = Promise.resolve();
  private storeFault = false;
  private edge: { file: EdgeFile | null; body: string; status: SourceStatus } = { file: null, body: '', status: { id: 'edge', state: 'none', count: null, at: null, why: '출처 없음' } };
  private wan: { read: WanRead | null; status: SourceStatus } = { read: null, status: { id: 'wan-ip', state: 'none', count: null, at: null, why: '출처 없음' } };
  private wanWasFresh = false;
  private lastBody = '';
  private samples = new Samples();
  private over = new Map<string, boolean>();
  private readings = new Map<string, Reading>();
  private health: SourceStatus = { id: 'health', state: 'none', count: null, at: null, why: '출처 없음' };
  private trends = new Map<string, { until: number; value: Promise<Trend> }>();
  private trendCalls: number[] = [];
  private trendFlying = 0;
  private trendRest = new Map<string, { until: number; fails: number; why: string }>();
  private rates = new Rates();
  private watch: Watch = emptyWatch();
  private watchLostUntil = 0;
  private partial: { name: string; why: string }[] = [];

  constructor(o: LiveOptions) {
    this.o = o; this.p = { ...PERIOD, ...o.period }; this.now = o.now ?? Date.now; this.limits = o.limits ?? DEFAULT_LIMITS;
    if (o.wanFault) this.wan.status = { id: 'wan-ip', state: 'failing', count: null, at: null, why: o.wanFault };
    else if (o.wanUrl) this.wan.status = { id: 'wan-ip', state: 'pending', count: null, at: null, why: WAITING };
    this.write(() => {});
    try { const text = readFileSync(this.file('changes.jsonl'), 'utf8'); this.changeLines = text.split('\n').length - 1; this.lineNo = lastLine(text); } catch { /* no history yet */ }
    this.restore();
  }

  private file(name: string) { return join(this.o.stateDir, name); }
  private iso() { return new Date(this.now()).toISOString(); }

  /** Design 4: the last state comes back first, and reads as stale on its own because its `at` is old. */
  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.file('state.json'), 'utf8')) as Persisted;
      if (s.schema !== 1) return;
      this.seq = s.seq; this.raw = s.raw; this.slots = s.slots; this.nextSlot = s.nextSlot;
      this.restoreWatch(s.watch);
      this.source.at = s.raw.fast?.at ?? null;
      this.restored = true;
      // The last public address comes back with its old time, or every restart would "change" what it compares.
      if (this.o.wanUrl && s.wan) { this.wan.read = s.wan; this.wan.status = { ...this.wan.status, at: s.wan.at }; this.wanWasFresh = this.wanFresh(); }
    } catch { /* no snapshot: a first start */ }
  }

  /** A file from before the memory has none, and that is fine. One that fails the check costs the memory alone: the rest of the state comes back. */
  private restoreWatch(saved: unknown) {
    if (saved === undefined) return;
    const w = parseWatch(saved);
    if (w) { this.watch = w; return; }
    this.watchLostUntil = this.now() + WATCH_LOST_S * 1000;
    this.dirty = true;
    this.log({ at: this.iso(), seq: this.seq, source: 'watch', state: 'failing', why: WATCH_LOST });
  }

  /** A disk problem must not stop the map. It shows as a source of its own and clears with the next write that works. */
  private write(f: () => void) {
    try {
      mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
      f();
      this.storeFault = false;
    } catch { this.storeFault = true; }
  }

  private save(force = false) {
    if (!this.dirty && !force) return;
    if (!force && this.now() - this.savedAt < 60_000) return;
    this.write(() => {
      const tmp = this.file(`state.json.${process.pid}`);
      const body: Persisted = { schema: 1, seq: this.seq, raw: this.raw, slots: this.slots, nextSlot: this.nextSlot, wan: this.wan.read, watch: this.watch };
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      renameSync(tmp, this.file('state.json'));
      this.savedAt = this.now(); this.dirty = false;
    });
  }

  private log(rec: object) {
    this.write(() => {
      const f = this.file('changes.jsonl');
      // A number of its own, in order: the history's cursor. Time cannot be one, two lines share a millisecond and rotation can split them.
      appendFileSync(f, `${JSON.stringify({ n: ++this.lineNo, ...rec })}\n`, { mode: 0o600 });
      this.changeLines += 1;
      if (this.changeLines > CHANGES_MAX * 1.1) {
        const tail = readFileSync(f, 'utf8').trimEnd().split('\n').slice(-CHANGES_MAX);
        const tmp = `${f}.${process.pid}`;
        writeFileSync(tmp, `${tail.join('\n')}\n`, { mode: 0o600 });
        renameSync(tmp, f);
        this.changeLines = tail.length;
      }
      chmodSync(f, 0o600);
    });
  }

  // --- turning reads into a snapshot

  /** Serial: layout is async, and two commits must not interleave. Never rejects: one failed build must not end every build after it. */
  private commit(inventory = false) {
    return (this.commits = this.commits.then(() => this.build(inventory)).catch(() => { this.failing('스냅샷 생성 실패'); }));
  }

  private ordered(nodes: Entity[]) {
    for (const n of nodes) this.slots[n.id] ??= this.nextSlot++;
    return [...nodes].sort((a, b) => this.slots[a.id]! - this.slots[b.id]!);
  }

  /** @param inventory this commit follows a good inventory read: the only thing that ends a gone object's cycle. */
  private async build(inventory: boolean) {
    const next = normalize(this.raw, this.now(), { edge: this.edge.file, wan: this.wan.read, wanOff: !this.o.wanUrl, local: this.o.local?.(this.now()) ?? null });
    const nextIds = new Set(next.nodes.map((n) => n.id));
    // Gone: last time here, this time absent from a good read. One cycle as an outline, then out. A failed read cannot get here with a shorter list.
    // Observed objects only: taking a declaration out of the file is the person's own act, and it reverts at once, tower or no tower.
    const gone = this.nodes.filter((n) => !n.gone && n.basis === 'observed' && !nextIds.has(n.id)).map((n) => ({ ...n, gone: true }));
    const carried = inventory ? [] : this.nodes.filter((n) => n.gone && !nextIds.has(n.id));
    const kept = [...next.nodes, ...gone, ...carried];
    const ids = new Set(kept.map((n) => n.id));
    const nodes = this.ordered(kept.filter((n) => !n.parent || ids.has(n.parent)));
    const nextHashes = hashesOf(next.nodes, next.edges);
    const nextStates = Object.fromEntries(next.nodes.map((n) => [n.id, n.state]));
    // What a restart brings back is the old state, not a change.
    const restored = this.baseline && this.restored;
    this.baseline = false;
    const change = diff(restored ? nextHashes : this.hashes, nextHashes, restored ? nextStates : this.states, nextStates);
    const empty = isEmpty(change);
    const goneChanged = gone.length > 0 || (inventory && this.nodes.some((n) => n.gone));
    // Everything that can throw comes before the first assignment: a failed build leaves the last good map whole, and the next one starts from it.
    const shape = JSON.stringify([nodes.map((n) => [n.id, n.parent ?? '']), next.edges.map((e) => e.id)]);
    const layout = shape === this.topology ? this.layout : await layoutSnapshot({ nodes, edges: next.edges }).then(({ layout: l, routes }) => ({ layout: l, routes }));
    this.layout = layout; this.topology = shape;
    this.hashes = nextHashes; this.states = nextStates;
    this.nodes = nodes; this.edges = next.edges;
    if (!empty || goneChanged) {
      this.seq += 1; this.dirty = true;
      if (!empty) this.log({ at: this.iso(), seq: this.seq, ...change });
    }
    if (inventory && this.raw.fast) this.watch = advance(this.watch, next.nodes, this.raw.tasks?.items ?? [], this.iso());
    if (inventory && this.raw.fast) this.samples.push(this.nodes, this.raw.fast.at, this.raw.fast.ttlS);
    this.save();
    this.publish();
  }

  private unplaced() { return unplacedServices(this.targets(), this.readings, this.ttlS(this.p.healthS)); }

  private targets(): Target[] { return this.edge.file ? targetsOf(this.edge.file, this.nodes) : []; }

  /** The computed layer: limits and service checks. Added here and not in `build`, so a percentage or a latency never counts as a change of the object. */
  private computed(): Entity[] {
    const verdicts: Verdicts = new Map();
    const expected = new Map((this.edge.file?.guests ?? []).flatMap((g) => (g.expected ? [[String(g.vmid), g.expected] as const] : [])));
    const checked = applyChecks(applyWatch(this.nodes, this.watch, expected), this.samples, this.limits, this.now(), verdicts);
    const nodes = applyRates(applyServices(checked, this.targets(), this.readings, this.ttlS(this.p.healthS)), this.rates, this.ttlS(this.p.metricsS), this.now());
    const alerts = [...verdicts].flatMap(([k, on]) => {
      const was = this.over.get(k); this.over.set(k, on);
      if (was === undefined ? !on : was === on) return [];
      const [id, metric] = k.split('|') as [string, string];
      return [{ id, text: `${metric} 임계 초과`, on }];
    });
    if (alerts.length) this.log({ at: this.iso(), seq: this.seq, alerts });
    return nodes;
  }

  private publish() {
    this.rev += 1;
    const count = this.nodes.filter((n) => !n.gone && (n.kind === 'node' || n.kind === 'vm' || n.kind === 'lxc')).length;
    const { zones, vnets, fw } = this.raw.cluster;
    const nums = { SDN: sum(zones, vnets), 방화벽: fw?.value ?? null };
    const counts = Object.fromEntries(Object.entries(nums).filter(([, v]) => v !== null)) as Record<string, number>;
    this.served = {
      schema: 1, seq: this.seq, takenAt: this.iso(), origin: 'live',
      nodes: this.computed(), edges: this.edges, limits: this.limits,
      ...(Object.keys(this.watch.missing).length ? { missing: Object.values(this.watch.missing) } : {}),
      ...(this.unplaced().length ? { unplaced: this.unplaced() } : {}),
      sources: [
        { ...this.source, count: this.raw.fast ? count : null, ...(Object.keys(counts).length ? { counts } : {}), ...(this.partial.length ? { partial: this.partial } : {}) },
        { ...this.edge.status, count: this.edge.status.state === 'none' ? null : this.nodes.filter((n) => n.basis === 'declared' && !n.gone).length },
        { id: 'docker', state: 'none', count: null, at: null, why: '출처 없음' },
        this.wan.status,
        this.health,
        ...(this.now() < this.watchLostUntil ? [{ id: 'watch', state: 'failing' as const, count: null, at: null, why: WATCH_LOST }] : []),
        ...(this.storeFault ? [{ id: 'store', state: 'failing' as const, count: null, at: null, why: '상태 저장 실패' }] : []),
      ],
      ...this.layout,
    };
  }

  private failing(why: string) {
    const was = this.source;
    this.source = { id: 'pve', state: 'failing', count: was.count, at: was.at, why };
    if (was.state !== 'failing' || was.why !== why) { this.log({ at: this.iso(), seq: this.seq, source: 'pve', state: 'failing', why }); this.publish(); }
  }

  private recovered(at: string) {
    const was = this.source;
    this.source = { id: 'pve', state: 'ok', count: was.count, at };
    if (was.state === 'failing') this.log({ at, seq: this.seq, source: 'pve', state: 'ok' }); // Starting up is no recovery.
  }

  // --- applying reads

  private ttlS(period: number) { return Math.max(this.p.minTtlS, period * 3); }

  private fastPeriodS() {
    if (this.now() - this.lastViewer > this.p.viewerGoneS * 1000) return this.p.idleS;
    const guests = this.raw.fast?.resources.filter(isGuest).length ?? 0;
    if (activeTask(this.raw.tasks?.items ?? [], this.now())) return this.p.activeS;
    return guests > LARGE_GUESTS ? this.p.largeS : this.p.fastS;
  }

  private async applyFast(r: FastRead) {
    const bad = [r.resources, r.status, r.tasks].find((x) => !x.ok && isSource(x.error));
    if (bad && !bad.ok) { this.samples.gap(); this.rates.gap(); this.failing(whyOf(bad.error)); return; }
    if (!r.resources.ok) { this.samples.gap(); this.rates.gap(); this.failing(whyOf(r.resources.error)); return; } // The inventory itself: without it nothing can be said, and a bad shape is no empty list.
    const at = this.iso();
    const ttlS = this.ttlS(this.fastPeriodS());
    this.raw.fast = { at, ttlS, resources: r.resources.value };
    if (r.status.ok) this.raw.status = { at, ttlS, rows: r.status.value };
    if (r.tasks.ok) this.raw.tasks = { at, ttlS, items: r.tasks.value };
    if (r.status.ok) delete this.raw.statusWhy; else this.raw.statusWhy = whyOf(r.status.error);
    this.partial = [...(r.tasks.ok ? [] : [{ name: '태스크', why: whyOf(r.tasks.error) }]), ...(r.status.ok ? [] : [{ name: '클러스터 상태', why: whyOf(r.status.error) }])];
    this.recovered(at);
    this.dirty = true;
    this.noteGuests();
    await this.commit(true);
    if (!Object.keys(this.raw.nodes).length) this.slowLoop?.kick(); // The first inventory names the nodes the slow reads need.
  }

  /** A new guest, or one whose status moved, is read now rather than on its next round (design 8). */
  private noteGuests() {
    const seen = new Set<string>();
    let due = false;
    const nodes = new Set<string>();
    for (const r of this.raw.fast?.resources ?? []) {
      if (r.type === 'node' && r.node) nodes.add(r.node);
      if (!isGuest(r)) continue;
      const key = guestKey(r); seen.add(key);
      if (this.guestStatus.get(key) !== r.status || !this.guestDue.has(key)) { this.guestDue.set(key, 0); due = true; }
      this.guestStatus.set(key, r.status ?? '');
    }
    for (const k of [...this.guestDue.keys()]) if (!seen.has(k)) { this.guestDue.delete(k); this.guestStatus.delete(k); }
    for (const k of Object.keys(this.raw.guests)) if (!seen.has(k)) delete this.raw.guests[k];
    for (const k of Object.keys(this.raw.nodes)) if (!nodes.has(k)) delete this.raw.nodes[k];
    if (due) this.guestLoop?.kick();
  }

  private part<T>(prev: Part<T> | undefined, t: Tried<T>, at: string, ttlS: number): Part<T> {
    if (t.ok) return { value: t.value, at, ttlS };
    return prev?.value != null ? prev : { value: null, at: null, ttlS, why: whyOf(t.error) };
  }

  private async applySlow(r: SlowRead | null) {
    if (!r) return;
    const all: Tried<unknown>[] = [r.zones, r.vnets, r.fw, ...Object.values(r.nodes).flatMap((n) => [n.network, n.dns, n.fw])];
    const bad = all.find((x) => !x.ok && isSource(x.error));
    if (bad && !bad.ok) { this.failing(whyOf(bad.error)); return; }
    const at = this.iso(); const ttlS = this.ttlS(this.p.slowS);
    for (const [n, x] of Object.entries(r.nodes)) {
      const p = (this.raw.nodes[n] ??= {});
      p.network = this.part(p.network, x.network, at, ttlS);
      p.dns = this.part(p.dns, x.dns, at, ttlS);
      p.fw = this.part(p.fw, x.fw, at, ttlS);
    }
    const c = this.raw.cluster;
    c.zones = this.part(c.zones, r.zones, at, ttlS); c.vnets = this.part(c.vnets, r.vnets, at, ttlS); c.fw = this.part(c.fw, r.fw, at, ttlS);
    this.dirty = true;
    await this.commit();
  }

  private async applyGuest(results: [GuestRef, GuestRead][]) {
    const bad = results.flatMap(([, g]) => [g.config, g.ip, g.os]).find((x) => x && !x.ok && isSource(x.error));
    if (bad && !bad.ok) { this.failing(whyOf(bad.error)); return; }
    const at = this.iso();
    for (const [g, x] of results) {
      const key = `${g.kind}:${g.vmid}`;
      const failed = !x.config.ok || (x.ip && !x.ip.ok) || (x.os && !x.os.ok);
      const nextS = failed ? this.p.guestFailS : this.p.guestS;
      const ttlS = this.ttlS(nextS); // Three times the wait to the next read. A guest without an agent waits longer, and its config is no less fresh for that.
      const p = (this.raw.guests[key] ??= {});
      p.config = this.part(p.config, x.config, at, ttlS);
      // An agent that stopped answering is a new blank with its reason, not an old address. A stopped guest has no agent to ask.
      const agent = <T>(t: Tried<T>): Part<T> => (t.ok ? { value: t.value, at, ttlS } : { value: null, at: null, ttlS, why: agentWhy(whyOf(t.error)) });
      if (x.ip) p.ip = agent(x.ip); else delete p.ip;
      if (x.os) p.os = agent(x.os); else delete p.os;
      this.guestDue.set(key, this.now() + nextS * 1000);
    }
    this.dirty = true;
    if (results.length) await this.commit();
  }

  private dueGuests(): GuestRef[] {
    const now = this.now();
    return (this.raw.fast?.resources ?? []).filter(isGuest).flatMap((r) => {
      const due = this.guestDue.get(guestKey(r));
      if (due === undefined || due > now || !validId(r.vmid) || !validNode(r.node)) return [];
      return [{ kind: r.type as 'qemu' | 'lxc', vmid: r.vmid, node: r.node, running: r.status === 'running' }];
    });
  }

  private onlineNodes() {
    const offline = new Set((this.raw.status?.rows ?? []).filter((s) => s.type === 'node' && s.online === 0).map((s) => s.name));
    return (this.raw.fast?.resources ?? []).filter((r) => r.type === 'node' && r.node && !offline.has(r.node) && r.status === 'online').map((r) => r.node!);
  }

  /** A bad file keeps the last good one on the map, and says so. Deleting the file is not a failure: the blanks come back. */
  private setEdge(r: EdgeRead) {
    const declaredAt = this.edge.file?.declaredAt ?? null;
    if (r.kind === 'none') this.edge = { file: null, body: '', status: { id: 'edge', state: 'none', count: null, at: null, why: '출처 없음' } };
    else if (r.kind === 'bad') this.edge = { ...this.edge, status: { id: 'edge', state: 'failing', count: null, at: declaredAt, why: `edge.json 오류 · ${r.why}` } };
    else this.edge = { file: r.file, body: JSON.stringify(r.file), status: { id: 'edge', state: 'ok', count: null, at: r.file.declaredAt } };
    // A list that has not been probed yet is waiting, not off.
    if (this.edge.file?.services?.length && this.health.state === 'none' && this.health.why === '출처 없음') this.health = { id: 'health', state: 'pending', count: null, at: null, why: WAITING };
  }

  /** Requests from `relief forget`. Only this process writes state.json, so it is the one to act on them. */
  takeForgets() {
    const done = consumeRequests(this.o.stateDir, (id) => this.forgetOne(id), this.now());
    if (done) { this.save(true); this.publish(); }
    return done;
  }

  private forgetOne(id: string): Reply {
    const here = new Set(this.nodes.filter((n) => !n.gone).map((n) => n.id));
    const { watch, reply } = forget(this.watch, id, here);
    this.watch = watch;
    if (reply.result === 'removed') { this.dirty = true; this.log({ at: this.iso(), seq: this.seq, removed: [id] }); }
    return reply;
  }

  private async applyEdge(r: EdgeRead) {
    const before = JSON.stringify(this.edge.status);
    this.setEdge(r);
    const fresh = this.wanFresh();
    const changed = r.kind === 'ok' ? this.lastBody !== this.edge.body : r.kind === 'none' && this.lastBody !== '';
    this.lastBody = this.edge.body;
    if (changed || fresh !== this.wanWasFresh) { this.wanWasFresh = fresh; await this.commit(); } else if (JSON.stringify(this.edge.status) !== before) this.publish();
  }

  private wanFresh() { const w = this.wan.read; return !!w && (this.now() - Date.parse(w.at)) / 1000 <= w.ttlS; }

  private async applyWan(r: Tried<string>) {
    const at = this.iso();
    if (r.ok) {
      const address = r.value;
      this.wan = { read: { address, at, ttlS: this.ttlS(this.p.wanS) }, status: { id: 'wan-ip', state: 'ok', count: 1, at } };
      this.wanWasFresh = true;
      await this.commit();
    } else {
      this.wan = { read: this.wan.read, status: { id: 'wan-ip', state: 'failing', count: null, at: this.wan.status.at, why: whyOf(r.error) } };
      this.publish();
    }
  }

  /** A list that is missing turns the source off. `[]` is "none declared": read, and nothing to do. */
  private async applyHealth(next: Map<string, Reading> | null) {
    const list = this.edge.file?.services;
    if (next === null || list === undefined) {
      if (this.health.state !== 'none') { this.readings.clear(); this.health = { id: 'health', state: 'none', count: null, at: null, why: '출처 없음' }; this.publish(); }
      return;
    }
    const at = this.iso();
    const moved = this.targets().flatMap((t) => {
      const b = next.get(t.id)?.result; const a = this.readings.get(t.id)?.result;
      // The object's id and the new answer: what edge.json says about a service stays out of the log (design 7.1).
      return b && a && a.up !== b.up ? [{ id: t.entity ?? 'health', to: b.up ? '응답' : '응답 없음' }] : [];
    });
    this.readings = next;
    if (moved.length) this.log({ at, seq: this.seq, services: moved });
    // `ok` claims a check ran. With nothing to probe nothing ran, whatever the file says.
    this.health = next.size ? { id: 'health', state: 'ok', count: next.size, at } : { id: 'health', state: 'none', count: 0, at: null, why: list.length ? '검사할 대상 없음' : '0개 선언' };
    this.publish();
  }

  // --- adapters

  private fastAdapter(): ReadAdapter<FastRead> { return { id: 'pve-fast', periodS: () => this.fastPeriodS(), read: (s) => readFast(this.o.reader, s) }; }
  private slowAdapter(): ReadAdapter<SlowRead | null> {
    return { id: 'pve-slow', periodS: () => (this.raw.nodes && Object.keys(this.raw.nodes).length ? this.p.slowS : this.p.guestTickS), read: async (s) => (this.raw.fast ? readSlow(this.o.reader, this.onlineNodes(), s) : null) };
  }
  private guestAdapter(): ReadAdapter<[GuestRef, GuestRead][]> {
    return {
      id: 'pve-guest', periodS: () => this.p.guestTickS,
      read: async (s) => {
        const todo = this.dueGuests(); const out: [GuestRef, GuestRead][] = [];
        const work = async () => { for (let g = todo.shift(); g; g = todo.shift()) out.push([g, await readGuest(this.o.reader, g, s)]); };
        await Promise.all(Array.from({ length: GUEST_CONCURRENCY }, work));
        return out;
      },
    };
  }
  private edgeAdapter(path: string): ReadAdapter<EdgeRead> { return { id: 'edge', periodS: () => this.p.edgeS, read: async () => readEdge(path) }; }
  private wanAdapter(url: string): ReadAdapter<Tried<string>> {
    return { id: 'wan-ip', periodS: () => this.p.wanS, read: (s) => readPublicIp(url, s).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })) };
  }
  private healthAdapter(): ReadAdapter<Map<string, Reading> | null> {
    return {
      id: 'health', periodS: () => this.p.healthS,
      read: async (s) => (this.edge.file?.services ? runChecks(this.targets(), this.o.probe ?? tcpProbe, () => this.iso(), s) : null),
    };
  }
  /** The only source of a node's byte counters, so a viewer on the map keeps it running; with nobody looking it stops (design 8). */
  private wantsMetrics() { return this.now() - this.lastOverlay <= this.p.overlayGoneS * 1000 || this.now() - this.lastViewer <= this.p.viewerGoneS * 1000; }

  private applyMetrics(m: MetricRead | null) {
    if (!m) { this.rates.gap(); return; }
    this.metrics = { at: this.iso(), values: m.values };
    const at = this.iso();
    for (const [id, c] of Object.entries(m.counters)) this.rates.push(id, c, at);
    this.rates.keep(new Set(Object.keys(m.counters)));
    this.publish();
  }

  private metricsAdapter(): ReadAdapter<MetricRead | 'off' | null> {
    return {
      id: 'pve-metrics', periodS: () => this.p.metricsS,
      read: async (s) => (!this.wantsMetrics() ? 'off' : readMetrics(this.o.reader, s).catch((e: unknown) => { if (isSource(e)) this.failing(whyOf(e)); return null; })),
    };
  }

  // --- life cycle

  /** The file goes in before the first build: a map drawn without it would "lose" every declared object at each restart. */
  private async prepare() {
    if (this.prepared) return;
    this.prepared = true;
    if (this.o.edgePath) { this.setEdge(readEdge(this.o.edgePath)); this.lastBody = this.edge.body; }
    await this.commit();
  }

  async start() {
    await this.prepare();
    this.takeForgets(); // A request left while the service was down.
    this.loops.push(runLoop({ id: 'forget', periodS: () => this.p.forgetS, read: async () => this.takeForgets() }, () => {}));
    const after = <R>(f: (r: R) => Promise<void>) => (r: R) => void f(r).catch((e: unknown) => console.error(`relief: apply: ${String((e as Error).name)}`));
    // Neither needs tower, so a Proxmox fault stops neither (design 1, criterion 5).
    if (this.o.edgePath) this.loops.push(runLoop(this.edgeAdapter(this.o.edgePath), after((r) => this.applyEdge(r))), runLoop(this.healthAdapter(), after((r) => this.applyHealth(r))));
    if (this.o.wanUrl) this.loops.push(runLoop(this.wanAdapter(this.o.wanUrl), after((r) => this.applyWan(r))));
    if (this.o.fault) { this.failing(this.o.fault); return; }
    this.fastLoop = runLoop(this.fastAdapter(), after((r) => this.applyFast(r)));
    this.guestLoop = runLoop(this.guestAdapter(), after((r) => this.applyGuest(r)));
    this.slowLoop = runLoop(this.slowAdapter(), after((r) => this.applySlow(r)));
    this.metricsLoop = runLoop(this.metricsAdapter(), (m) => { if (m !== 'off') this.applyMetrics(m); });
    this.loops.push(this.fastLoop, this.guestLoop, this.slowLoop, this.metricsLoop);
  }

  async stop() {
    for (const l of this.loops) l.stop();
    this.loops = [];
    await this.commits;
    this.save(true);
  }

  /** One full collection without timers: fast, slow, guests. */
  async collectOnce(signal = new AbortController().signal) {
    await this.prepare();
    if (this.o.edgePath) await this.applyEdge(await this.edgeAdapter(this.o.edgePath).read(signal));
    if (this.o.wanUrl) await this.applyWan(await this.wanAdapter(this.o.wanUrl).read(signal));
    await this.applyFast(await this.fastAdapter().read(signal));
    await this.applySlow(await this.slowAdapter().read(signal));
    await this.applyGuest(await this.guestAdapter().read(signal));
    await this.applyHealth(await this.healthAdapter().read(signal));
  }

  // --- the API's view

  /** Called by each browser poll. A viewer coming back after the slow pace gets a read now, not in up to 60 s. */
  touch() {
    const idle = this.now() - this.lastViewer > this.p.viewerGoneS * 1000;
    this.lastViewer = this.now();
    if (idle) {
      // Nobody read the counters while nobody looked. What is left of the rates is old, and a viewer coming back must see them waiting, not stale.
      this.rates.gap();
      if (this.served) this.publish();
      this.fastLoop?.kick(); this.metricsLoop?.kick();
    }
  }

  /** `seq` alone would hide a new `at` from the browser, and the map would go stale while reads succeed. `rev` moves with each published read. */
  view(): Served { return { snapshot: this.served!, etag: `"${this.seq}.${this.rev}"` }; }

  /** Only an object on the map can be asked for, and its path comes from the last inventory, never from the request. Null: no such object. */
  private trendRef(id: string): TrendRef | 'bad' | null {
    for (const r of this.raw.fast?.resources ?? []) {
      if (r.type === 'node' && `pve:node:${r.node}` === id) return validNode(r.node) ? { kind: 'node', node: r.node } : 'bad';
      if (isGuest(r) && `pve:${r.type}:${String(r.vmid)}` === id) return validNode(r.node) && validId(r.vmid) ? { kind: r.type as 'qemu' | 'lxc', node: r.node, vmid: r.vmid } : 'bad';
    }
    return null;
  }

  /** One metrics read outside the loop. A full collection leaves it out: it is the viewer's, not the inventory's. */
  async collectMetrics(signal = new AbortController().signal) { const m = await this.metricsAdapter().read(signal); if (m !== 'off') this.applyMetrics(m); }

  /** A read may start: fewer than `perMin` in the last minute and fewer than `inFlight` running. */
  private trendSlot() {
    const now = this.now();
    this.trendCalls = this.trendCalls.filter((t) => now - t < 60_000);
    return this.trendCalls.length < TREND_LIMIT.perMin && this.trendFlying < TREND_LIMIT.inFlight;
  }

  /** On demand, once per object and window while the cache holds. Over the limits nothing is sent; a failed read rests that object, longer each time. */
  trend(id: string, tf: Timeframe): Promise<Trend> | null {
    const ref = this.trendRef(id);
    if (ref === null) return null;
    if (ref === 'bad') return Promise.resolve({ id, tf, at: null, points: [], why: '이름이 경로 규칙에 맞지 않아 읽지 않았다' });
    const key = `${id}|${tf}`;
    const hit = this.trends.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const rest = this.trendRest.get(key);
    if (rest && rest.until > this.now()) return Promise.resolve({ id, tf, at: null, points: [], why: rest.why });
    if (!this.trendSlot()) return Promise.resolve({ id, tf, at: null, points: [], why: BUSY });
    const until = this.now() + TREND_CACHE_S[tf] * 1000;
    this.trendCalls.push(this.now()); this.trendFlying += 1;
    const value = readTrend(this.o.reader, ref, tf).then(
      (points): Trend => { this.trendRest.delete(key); return { id, tf, at: this.iso(), points }; },
      (e: unknown): Trend => {
        this.trends.delete(key);
        const why = whyOf(e); const fails = (this.trendRest.get(key)?.fails ?? 0) + 1;
        this.trendRest.set(key, { fails, why, until: this.now() + Math.min(TREND_LIMIT.backoffMaxS, TREND_LIMIT.backoffS * 2 ** (fails - 1)) * 1000 });
        return { id, tf, at: null, points: [], why };
      },
    ).finally(() => { this.trendFlying -= 1; });
    this.trends.delete(key); this.trends.set(key, { until, value });
    for (const k of this.trends.keys()) { if (this.trends.size <= TREND_KEEP) break; this.trends.delete(k); }
    return value;
  }

  changes(q: ChangeQuery): ChangePage { return readChanges(this.file('changes.jsonl'), q); }

  viewMetrics() { this.lastOverlay = this.now(); return this.metrics; }

  status(): LiveStatus { return { seq: this.seq, sources: this.served?.sources ?? [this.source], calls: this.o.reader.record, lastRead: this.source.at, missing: Object.values(this.watch.missing).map(({ id, title, since }) => ({ id, title, since })) }; }
}

const lastLine = (text: string) => { try { return (JSON.parse(text.trimEnd().split('\n').at(-1) ?? '{}') as { n?: number }).n ?? 0; } catch { return 0; } };
const sum = (a?: Part<number>, b?: Part<number>) => (a?.value == null || b?.value == null ? null : a.value + b.value);
const agentWhy = (why: string) => (why.startsWith('PVE API 5') ? 'guest agent 응답 없음' : why);
