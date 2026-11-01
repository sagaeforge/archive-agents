// The live map: three loops feed `Raw`, every result is normalised, compared and served. Failure paths are here (design 6.6): a failed read leaves `Raw` alone.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop, type Loop, type ReadAdapter } from './collect/adapter.ts';
import { readEdge, type EdgeFile, type EdgeRead } from './collect/edge.ts';
import type { Reader } from './collect/mcp.ts';
import { isSource, readFast, readGuest, readMetrics, readSlow, validId, validNode, whyOf, type FastRead, type GuestRead, type GuestRef, type MetricValues, type SlowRead, type Tried } from './collect/pve.ts';
import { readPublicIp } from './collect/wanip.ts';
import { layoutSnapshot } from './layout/elk.ts';
import { diff, hashesOf, isEmpty, type Hashes, type StateMap } from './model/diff.ts';
import type { Entity, Relation, Snapshot, SourceStatus } from './model/fact.ts';
import type { WanRead } from './model/edgemap.ts';
import { activeTask, emptyRaw, guestKey, isGuest, normalize, type Part, type Raw } from './model/normalize.ts';

// activeS + the browser's 5 s must stay inside the 10 s budget of design 13.
export const PERIOD = { fastS: 15, activeS: 4, idleS: 60, largeS: 30, slowS: 300, guestS: 600, guestFailS: 1800, guestTickS: 20, metricsS: 15, viewerGoneS: 120, overlayGoneS: 30, minTtlS: 45, edgeS: 10, wanS: 600 };
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
  localIps?: () => string[];
  now?: () => number;
};

export type Served = { snapshot: Snapshot; etag: string };
export type LiveStatus = { seq: number; sources: SourceStatus[]; calls: Reader['record']; lastRead: string | null };

type Persisted = { schema: 1; seq: number; raw: Raw; slots: Record<string, number>; nextSlot: number; wan?: WanRead | null };

export class Live {
  private o: LiveOptions;
  private p: typeof PERIOD;
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
  private source: SourceStatus = { id: 'pve', state: 'failing', count: null, at: null, why: WAITING };
  private served: Snapshot | null = null;
  private metrics: { at: string | null; values: MetricValues } = { at: null, values: {} };
  private loops: Loop[] = [];
  private fastLoop: Loop | null = null;
  private guestLoop: Loop | null = null;
  private slowLoop: Loop | null = null;
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
  private commits: Promise<void> = Promise.resolve();
  private storeFault = false;
  private edge: { file: EdgeFile | null; body: string; status: SourceStatus } = { file: null, body: '', status: { id: 'edge', state: 'none', count: null, at: null, why: '출처 없음' } };
  private wan: { read: WanRead | null; status: SourceStatus } = { read: null, status: { id: 'wan-ip', state: 'none', count: null, at: null, why: '출처 없음' } };
  private wanWasFresh = false;
  private lastBody = '';

  constructor(o: LiveOptions) {
    this.o = o; this.p = { ...PERIOD, ...o.period }; this.now = o.now ?? Date.now;
    if (o.wanFault) this.wan.status = { id: 'wan-ip', state: 'failing', count: null, at: null, why: o.wanFault };
    else if (o.wanUrl) this.wan.status = { id: 'wan-ip', state: 'failing', count: null, at: null, why: WAITING };
    this.write(() => {});
    try { this.changeLines = readFileSync(this.file('changes.jsonl'), 'utf8').split('\n').length - 1; } catch { /* no history yet */ }
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
      this.source.at = s.raw.fast?.at ?? null;
      this.restored = true;
      // The last public address comes back with its old time, or every restart would "change" what it compares.
      if (this.o.wanUrl && s.wan) { this.wan.read = s.wan; this.wan.status = { ...this.wan.status, at: s.wan.at }; this.wanWasFresh = this.wanFresh(); }
    } catch { /* no snapshot: a first start */ }
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
      const body: Persisted = { schema: 1, seq: this.seq, raw: this.raw, slots: this.slots, nextSlot: this.nextSlot, wan: this.wan.read };
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      renameSync(tmp, this.file('state.json'));
      this.savedAt = this.now(); this.dirty = false;
    });
  }

  private log(rec: object) {
    this.write(() => {
      const f = this.file('changes.jsonl');
      appendFileSync(f, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
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
    const next = normalize(this.raw, this.now(), { edge: this.edge.file, wan: this.wan.read, wanOff: !this.o.wanUrl, localIps: this.o.localIps?.() ?? [] });
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
    this.save();
    this.publish();
  }

  private publish() {
    this.rev += 1;
    const count = this.nodes.filter((n) => !n.gone && (n.kind === 'node' || n.kind === 'vm' || n.kind === 'lxc')).length;
    const { zones, vnets, fw } = this.raw.cluster;
    const nums = { SDN: sum(zones, vnets), 방화벽: fw?.value ?? null };
    const counts = Object.fromEntries(Object.entries(nums).filter(([, v]) => v !== null)) as Record<string, number>;
    this.served = {
      schema: 1, seq: this.seq, takenAt: this.iso(), origin: 'live',
      nodes: this.nodes, edges: this.edges,
      sources: [
        { ...this.source, count: this.raw.fast ? count : null, ...(Object.keys(counts).length ? { counts } : {}) },
        { ...this.edge.status, count: this.edge.status.state === 'none' ? null : this.nodes.filter((n) => n.basis === 'declared' && !n.gone).length },
        { id: 'docker', state: 'none', count: null, at: null, why: '출처 없음' },
        this.wan.status,
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
    if (was.state === 'failing' && was.why !== WAITING) this.log({ at, seq: this.seq, source: 'pve', state: 'ok' }); // Starting up is no recovery.
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
    if (bad && !bad.ok) { this.failing(whyOf(bad.error)); return; }
    if (!r.resources.ok) { this.failing(whyOf(r.resources.error)); return; } // The inventory itself: without it nothing can be said, and a bad shape is no empty list.
    const at = this.iso();
    const ttlS = this.ttlS(this.fastPeriodS());
    this.raw.fast = { at, ttlS, resources: r.resources.value };
    if (r.status.ok) this.raw.status = { at, ttlS, rows: r.status.value };
    if (r.tasks.ok) this.raw.tasks = { at, ttlS, items: r.tasks.value };
    if (r.status.ok) delete this.raw.statusWhy; else this.raw.statusWhy = whyOf(r.status.error);
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
  private metricsAdapter(): ReadAdapter<MetricValues | null> {
    return {
      id: 'pve-metrics', periodS: () => this.p.metricsS,
      read: async (s) => (this.now() - this.lastOverlay > this.p.overlayGoneS * 1000 ? null : readMetrics(this.o.reader, s).catch((e: unknown) => { if (isSource(e)) this.failing(whyOf(e)); return null; })),
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
    const after = <R>(f: (r: R) => Promise<void>) => (r: R) => void f(r).catch((e: unknown) => console.error(`relief: apply: ${String((e as Error).name)}`));
    // Neither needs tower, so a Proxmox fault stops neither (design 1, criterion 5).
    if (this.o.edgePath) this.loops.push(runLoop(this.edgeAdapter(this.o.edgePath), after((r) => this.applyEdge(r))));
    if (this.o.wanUrl) this.loops.push(runLoop(this.wanAdapter(this.o.wanUrl), after((r) => this.applyWan(r))));
    if (this.o.fault) { this.failing(this.o.fault); return; }
    this.fastLoop = runLoop(this.fastAdapter(), after((r) => this.applyFast(r)));
    this.guestLoop = runLoop(this.guestAdapter(), after((r) => this.applyGuest(r)));
    this.slowLoop = runLoop(this.slowAdapter(), after((r) => this.applySlow(r)));
    this.loops.push(this.fastLoop, this.guestLoop, this.slowLoop, runLoop(this.metricsAdapter(), (m) => { if (m) this.metrics = { at: this.iso(), values: m }; }));
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
  }

  // --- the API's view

  /** Called by each browser poll. A viewer coming back after the slow pace gets a read now, not in up to 60 s. */
  touch() {
    const idle = this.now() - this.lastViewer > this.p.viewerGoneS * 1000;
    this.lastViewer = this.now();
    if (idle) this.fastLoop?.kick();
  }

  /** `seq` alone would hide a new `at` from the browser, and the map would go stale while reads succeed. `rev` moves with each published read. */
  view(): Served { return { snapshot: this.served!, etag: `"${this.seq}.${this.rev}"` }; }

  viewMetrics() { this.lastOverlay = this.now(); return this.metrics; }

  status(): LiveStatus { return { seq: this.seq, sources: this.served?.sources ?? [this.source], calls: this.o.reader.record, lastRead: this.source.at }; }
}

const sum = (a?: Part<number>, b?: Part<number>) => (a?.value == null || b?.value == null ? null : a.value + b.value);
const agentWhy = (why: string) => (why.startsWith('PVE API 5') ? 'guest agent 응답 없음' : why);
