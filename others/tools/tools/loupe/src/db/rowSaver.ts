// The save machine of one record of a database view (design v2 4.3, 5.2, 5.3, 5.5, 5.7, 5.9). A cell is a property of the record, and a cell edit is a new version of the
// whole record: a PUT whose `record.props` is the whole object (the record as read, with the cells changed), on `expected_version`. This is src/memo/saver.ts for a record
// whose text is not the thing that changes. No React and no network of its own: the table gives it the network, the clock and the registry.
//
//  - One save in flight per record. A cell edited meanwhile joins the next send, which goes out on the version the answer brought (5.2 "저장 직렬화").
//  - The edit key is `loupe:e:<id>:v<expected>:save:r<n>`. A resend of the same content on the same version keeps its key (the KB then answers with its first answer);
//    other content on the same version takes the next r.
//  - A 409 whose `current.payload_sha` is the hash of what this saver last sent is its own earlier save: it goes on top of `current.version`, with no conflict band.
//    Any other 409 is a conflict (5.3): nothing is sent until the person chooses. The other side is never overwritten by itself.
//  - Nothing leaves while the pre-check matches (5.7); a 422 (5.5) drops the value from every field of this object and keeps the rule id and the time.
import { recordFields, type Hit, type Precheck } from '../../server/precheck.ts';
import { payloadSha, type NoteRecord } from '../memo/ids.ts';
import type { RefState, WriteResult } from '../memo/api.ts';
import { nextProps, type Props } from './rows.ts';

/** The record as the KB has it: all that a PUT has to send besides the props. `sensitivity` stays what it is (a PUT cannot lower it, 5.6). */
export type Loaded = { type: 'Note' | 'Page'; title: string; body: string; sensitivity: 'private' | 'internal'; props: Props; version: number };
export type LoadResult = Loaded | 'partial' | 'gone' | 'network';
export type State = 'idle' | 'saving' | 'pending' | 'offline' | 'blocked' | 'rejected' | 'conflict' | 'quarantined' | 'invalid' | 'throttled' | 'auth';
export type Conflict = {
  current: { version: number; status: string; actor: string | null; props: Props; title: string | null; body: string | null; truncated: boolean };
  /** My cells, by property name: what the person wanted when the KB had moved on. */
  mine: Props;
};
export type RowSnap = {
  state: State;
  /** A reason in words for `invalid`, `auth`, `throttled`, `pending`. */
  detail: string | null;
  /** The record as this saver knows the KB has it; null until the first edit has read it. */
  version: number | null;
  title: string | null;
  props: Props | null;
  /** The cells sent or waiting to be sent, for the table to show while the save is on its way. Empty while the pre-check holds a value. */
  cells: Props;
  /** The rules that matched (by id, with the field's kind), never the matched text. */
  hits: readonly { rule: string; field: string }[];
  hitsFrom: 'precheck' | 'kb' | null;
  conflict: Conflict | null;
};

export type RowDeps = {
  post: (path: string, body: unknown) => Promise<WriteResult>;
  readRef: (ref: string) => Promise<RefState>;
  load: (id: string) => Promise<LoadResult>;
  precheck: () => Precheck | null;
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  track: { write: (ref: string) => void; unwrite: (ref: string) => void; rejected: (e: { record: string; rule: string; at: string }) => void; unrejected: (record: string) => void };
};

type Attempt = { key: string; expected: number; sha: string; props: Props; cells: Props };
const RETRY_MS = [2000, 5000, 15_000, 30_000];
const POLL_MS = [1000, 2000, 45_000];
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const RULE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** `record.props[3].value[1]` is a field of the props; `record.title` is the title. The band names the kind, not the position. */
const fieldKind = (f: string) => (f === 'record.title' ? 'title' : f === 'record.body' ? 'body' : 'props');

export class RowSaver {
  readonly id: string;
  private deps: RowDeps;
  private base: Loaded | null = null;
  private seen = 0;
  private cells: Props = {};
  private state: State = 'idle';
  private detail: string | null = null;
  private hits: { rule: string; field: string }[] = [];
  private hitsFrom: 'precheck' | 'kb' | null = null;
  private conflict: Conflict | null = null;
  private attempt: Attempt | null = null;
  /** An earlier send whose answer never came, when another content has been sent since: the KB may have kept it (5.2 "자기 저장 인식"). */
  private lost: Attempt | null = null;
  private revs = new Map<number, number>();
  private anyway = false;
  private pending: { ref: string; attempt: Attempt } | null = null;
  private running = false;
  private want = false;
  private retryHandle: unknown = null;
  private retryCount = 0;
  private pollHandle: unknown = null;
  private pollCount = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private snap: RowSnap;

  constructor(id: string, deps: RowDeps) {
    this.id = id; this.deps = deps;
    this.snap = this.build();
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = (): RowSnap => this.snap;
  private build(): RowSnap {
    return {
      state: this.state, detail: this.detail, version: this.base?.version ?? null, title: this.base?.title ?? null, props: this.base ? { ...this.base.props } : null,
      cells: this.state === 'blocked' ? {} : { ...this.cells }, hits: this.hits.map((h) => ({ ...h })), hitsFrom: this.hitsFrom, conflict: this.conflict,
    };
  }
  private emit() { if (this.disposed) return; this.snap = this.build(); this.listeners.forEach((l) => l()); }

  // ---- an edit
  /**
   * The person set one property of the record to `value`. `seen` is the version the table showed: the first send is on it, so a record that moved on since is a 409
   * and not a silent overwrite. `anyway` is "일반으로 보내기": the pre-check's match is not a secret, for this content only (5.7).
   */
  async edit(seen: number, key: string, value: unknown, o: { anyway?: boolean } = {}): Promise<void> {
    if (this.disposed || this.state === 'quarantined' || this.conflict) return;
    this.cells = { ...this.cells, [key]: value };
    this.seen = Math.max(this.seen, seen);
    this.anyway = o.anyway === true;
    this.hits = []; this.hitsFrom = null;
    this.want = true;
    this.clearRetry();
    await this.pump();
  }

  private async pump() {
    if (this.running || this.pending) { this.emit(); return; }
    this.running = true; this.emit();
    try {
      while (this.want && !this.pending && !this.disposed && !this.conflict) {
        this.want = false;
        await this.sendOnce();
      }
    } finally { this.running = false; this.emit(); }
  }

  private async ensureBase(): Promise<Loaded | null> {
    if (this.base && this.base.version >= this.seen) return this.base;
    // The table is newer than what this saver knows (or knows nothing): read the record. The send is on the version the person saw, whatever the read says.
    const r = await this.deps.load(this.id);
    if (r === 'partial') { this.fail('invalid', '본문이 길어 여기서는 고치지 않는다'); return null; }
    if (r === 'gone') { this.fail('invalid', '없거나 볼 수 없다'); return null; }
    if (r === 'network') { this.fail('invalid', '기록을 읽지 못했다'); return null; }
    this.base = { ...r, version: this.seen };
    return this.base;
  }
  /** The edit cannot go on: the value is dropped (the table shows what the KB has) and the reason stays until the person closes it. */
  private fail(state: 'invalid' | 'auth', detail: string) {
    this.cells = {}; this.attempt = null; this.anyway = false;
    this.state = state; this.detail = detail;
  }

  private recordOf(base: Loaded, props: Props): NoteRecord {
    return { type: base.type, title: base.title, body: base.body, body_format: 'markdown', sensitivity: base.sensitivity, props, links: [] };
  }

  private async sendOnce() {
    const base = await this.ensureBase();
    if (!base) return;
    const props = nextProps(base.props, this.cells);
    if (same(props, base.props)) { this.cells = {}; this.attempt = null; this.state = 'idle'; this.detail = null; return; }
    const pre = this.deps.precheck();
    const found = pre ? pre.scan(recordFields({ record: { props } })) : [];
    if (found.length > 0 && !this.anyway) {
      this.hits = found.map((h: Hit) => ({ rule: h.rule, field: fieldKind(h.field) })); this.hitsFrom = 'precheck';
      this.state = 'blocked'; this.detail = null;
      return;
    }
    const record = this.recordOf(base, props);
    const sha = await payloadSha(record);
    const expected = base.version;
    let key: string;
    if (this.attempt && this.attempt.expected === expected && this.attempt.sha === sha) key = this.attempt.key;
    else { const r = (this.revs.get(expected) ?? 0) + 1; this.revs.set(expected, r); key = `loupe:e:${this.id}:v${expected}:save:r${r}`; }
    const attempt: Attempt = { key, expected, sha, props, cells: { ...this.cells } };
    if (this.attempt && this.attempt.sha !== sha) this.lost = this.attempt;
    this.attempt = attempt;
    this.state = 'saving'; this.detail = null; this.emit();
    const result = await this.deps.post(`/records/${encodeURIComponent(this.id)}`, { idempotency_key: key, change: 'save', expected_version: expected, record });
    if (this.disposed) return;
    await this.settle(result, attempt);
  }

  private async settle(r: WriteResult, a: Attempt) {
    if (r.t === 'network') {
      this.state = 'offline'; this.detail = null;
      this.retryLater(RETRY_MS[Math.min(this.retryCount++, RETRY_MS.length - 1)]!);
      return;
    }
    this.retryCount = 0;
    const lost = this.lost;
    this.lost = null;
    if (r.t === 'ok') { this.accepted(r, a); return; }
    const { status, code, body } = r;
    if (status === 422 && code === 'secret_detected') { this.refused(body); return; }
    if (status === 409) { this.conflicted(body, a, lost); return; }
    if (status === 401) { this.fail('auth', code === 'session_required' ? '로그인이 필요하다' : 'KB 쓰기 권한이 없다'); return; }
    if (status === 503 && code === 'token_not_configured') { this.fail('auth', 'KB 쓰기 권한이 없다'); return; }
    if (status === 403 && code === 'sensitivity_not_allowed') { this.fail('invalid', 'KB가 이 공개 범위를 받지 않는다'); return; }
    if (status === 429 || (status === 503 && (code === 'gate_busy' || code === 'spool_full'))) {
      const sec = r.retryAfterSec ?? 5;
      this.state = 'throttled'; this.detail = '저장이 잠시 밀렸다';
      this.retryLater(sec * 1000);
      return;
    }
    this.fail('invalid', status === 404 ? '없거나 볼 수 없다' : code ?? `HTTP ${status}`);
  }

  private accepted(r: Extract<WriteResult, { t: 'ok' }>, a: Attempt) {
    const b = r.body;
    if (b.quarantined === true) { this.quarantined(); return; }
    if (r.status === 202) {
      const ref = typeof b.write_ref === 'string' ? b.write_ref : null;
      if (!ref) { this.fail('invalid', '대기 번호가 없는 202'); return; }
      this.pending = { ref, attempt: a };
      this.state = 'pending'; this.detail = b.held === true ? '보관 경로가 없다' : '쓰기 관문이 느리다';
      this.deps.track.write(ref);
      this.pollCount = 0;
      this.pollLater();
      return;
    }
    this.commit(a, typeof b.version === 'number' ? b.version : null);
  }
  /** The KB took `a`: the record is now its props, on the version the answer named. Cells edited after `a` was sent stay and go out next. */
  private commit(a: Attempt, version: number | null) {
    if (this.base) this.base = { ...this.base, props: a.props, version: version ?? this.base.version };
    for (const [k, v] of Object.entries(a.cells)) if (same(this.cells[k], v)) delete this.cells[k];
    this.attempt = null; this.anyway = false; this.state = 'idle'; this.detail = null; this.hits = []; this.hitsFrom = null;
    if (Object.keys(this.cells).length > 0) this.want = true;
    this.deps.track.unrejected(this.id);
  }

  private refused(b: Record<string, unknown>) {
    const hits = (Array.isArray(b.hits) ? b.hits : []).map(rec).filter((h): h is { rule: string; field: string } => typeof h.rule === 'string' && typeof h.field === 'string');
    this.hits = hits.map((h) => ({ rule: h.rule, field: fieldKind(h.field) })); this.hitsFrom = 'kb';
    // The value goes: from the cells, the attempt and the lost one. The table shows what the KB has, and what was typed is nowhere but in the field it was typed into (and that is cleared).
    this.cells = {}; this.attempt = null; this.lost = null; this.anyway = false; this.want = false;
    this.state = 'rejected'; this.detail = null;
    const rule = hits[0]?.rule;
    if (rule && RULE_ID.test(rule)) this.deps.track.rejected({ record: this.id, rule, at: this.deps.now().toISOString() });
  }

  /** The KB set the record aside as `secret` (5.5): nothing of it is left to show. The table drops the row. */
  private quarantined() {
    this.cells = {}; this.attempt = null; this.lost = null; this.anyway = false; this.want = false; this.base = null;
    this.state = 'quarantined'; this.detail = null;
  }

  private conflicted(b: Record<string, unknown>, a: Attempt, lost: Attempt | null) {
    const c = rec(b.current);
    if (typeof c.version !== 'number') { this.fail('invalid', typeof b.code === 'string' ? b.code : 'HTTP 409'); return; }
    const sha = typeof c.payload_sha === 'string' ? c.payload_sha : null;
    const own = sha === null ? null : [a, lost].find((x): x is Attempt => !!x && x.sha === sha) ?? null;
    if (own) {
      // My own earlier save, whose answer I never got: build on it, and send what came after it.
      this.commit(own, c.version);
      this.want = Object.keys(this.cells).length > 0;
      return;
    }
    const current = {
      version: c.version, status: typeof c.status === 'string' ? c.status : 'active', actor: typeof c.actor === 'string' ? c.actor : null, props: rec(c.props),
      title: typeof c.title === 'string' ? c.title : null, body: typeof c.body === 'string' ? c.body : null, truncated: c.body_truncated === true,
    };
    this.conflict = { current, mine: { ...this.cells } };
    this.cells = {}; this.attempt = null; this.anyway = false; this.want = false;
    this.state = 'conflict'; this.detail = null;
  }

  // ---- after a 202
  private pollLater() {
    if (this.pollHandle !== null || !this.pending) return;
    const delay = POLL_MS[Math.min(this.pollCount++, POLL_MS.length - 1)]!;
    this.pollHandle = this.deps.setTimer(() => { this.pollHandle = null; void this.poll(); }, delay);
  }
  private async poll() {
    const p = this.pending;
    if (!p || this.disposed) return;
    const s = await this.deps.readRef(p.ref);
    if (this.disposed || this.pending?.ref !== p.ref) return;
    if (s === 'network' || (s !== 'gone' && (s.state === 'pending' || s.state === 'unknown'))) { this.pollLater(); return; }
    this.pending = null;
    if (s !== 'gone' && s.state === 'committed') {
      this.commit(p.attempt, s.version);
      this.deps.track.unwrite(p.ref);
      this.emit();
      if (this.want) void this.pump();
      return;
    }
    if (s !== 'gone' && s.state === 'failed') { this.fail('invalid', `저장 실패 · ${s.code ?? '이유 알 수 없음'}`); this.emit(); return; }
    // purged or gone: the KB no longer has it. The value is dropped with the reason.
    this.deps.track.unwrite(p.ref);
    this.fail('invalid', 'KB에 남지 않았다');
    this.emit();
  }

  // ---- ways out
  /** "저쪽 것 가져오기": the record is what the other side made it. Nothing is written. */
  takeTheirs() {
    const c = this.conflict;
    if (!c) return;
    this.conflict = null; this.cells = {};
    if (c.current.status === 'active' && this.base) this.base = { ...this.base, title: c.current.title ?? this.base.title, body: c.current.body ?? this.base.body, props: c.current.props, version: c.current.version };
    else this.base = null;
    this.state = 'idle'; this.detail = null;
    this.emit();
  }
  /** "내 것으로 덮어쓰기": my cells on top of the other side's props, on their version. Their other properties stay. */
  async keepMine() {
    const c = this.conflict;
    if (!c || c.current.status !== 'active' || !this.base) return;
    if (c.current.truncated || c.current.title === null || c.current.body === null) { this.conflict = null; this.fail('invalid', '저쪽 본문이 길어 여기서는 덮어쓰지 않는다'); this.emit(); return; }
    this.base = { ...this.base, title: c.current.title, body: c.current.body, props: c.current.props, version: c.current.version };
    this.seen = c.current.version;
    this.cells = { ...c.mine }; this.conflict = null; this.want = true; this.anyway = false;
    await this.pump();
  }
  /** The person closes a band, or gives up the value the pre-check holds. */
  dismiss() {
    if (this.conflict || this.state === 'saving' || this.state === 'pending') return;
    if (this.state === 'blocked') this.cells = {};
    this.hits = []; this.hitsFrom = null; this.anyway = false; this.detail = null;
    this.state = 'idle';
    this.emit();
  }

  // ---- timers
  private retryLater(ms: number) {
    this.clearRetry();
    this.retryHandle = this.deps.setTimer(() => { this.retryHandle = null; this.want = true; void this.pump(); }, ms);
  }
  private clearRetry() { if (this.retryHandle !== null) { this.deps.clearTimer(this.retryHandle); this.retryHandle = null; } }
  dispose() {
    this.disposed = true; this.clearRetry();
    if (this.pollHandle !== null) { this.deps.clearTimer(this.pollHandle); this.pollHandle = null; }
    this.listeners.clear();
  }
}
