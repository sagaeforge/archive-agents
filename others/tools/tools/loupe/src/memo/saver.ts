// The save machine of one memo (design v2 5.2, 5.3, 5.5, 5.7, 5.9). No React and no network of its own: the window feeds it the text and gives it the
// network, the clock and the registry, so every rule below is a plain state change.
//
//  - One save in flight. A save asked for meanwhile waits and sends the last text, on the version the answer brought (5.2 "저장 직렬화").
//  - The create key `loupe:c:<uuid>` and the edit key `loupe:e:<id>:v<expected>:save:r<n>`. A resend of the same text on the same version keeps its
//    key (the KB then answers with its first answer); a different text on the same version takes the next r.
//  - A 409 whose `current.payload_sha` is the hash of what this window last sent is the window's own earlier save: it rebases on `current.version`
//    and sends on, with no conflict band. Any other 409 with a body is a conflict (5.3): the text stays and the band offers the ways out.
//  - Nothing leaves while the precheck matches (5.7); a 422 (5.5) paints the KB's ranges and offers "비밀 아님 · 격리 보관" for a create.
//  - The text of a refused or quarantined save is dropped from every field of this object, so it lives only in the editor until the person removes it.
import { recordFields, type Hit, type Precheck } from '../../server/precheck.ts';
import { deriveRecordId, payloadSha, type NoteRecord } from './ids.ts';
import { titleOf } from './title.ts';
import type { RefState, WriteResult } from './api.ts';

export type Net =
  | { kind: 'offline' }
  | { kind: 'token' }
  | { kind: 'session' }
  | { kind: 'closed' }
  | { kind: 'throttled'; retryAt: number }
  | { kind: 'invalid'; message: string };
export type Current = { version: number; status: string; payloadSha: string | null; body: string; actor: string | null };
export type Chip = 'empty' | 'dirty' | 'saving' | 'saved' | 'unchanged' | 'pending' | 'failed' | 'blocked' | 'rejected' | 'conflict' | 'quarantined' | 'large' | Net['kind'];
/** ADR-0005 4.5: a body of 1 MiB is refused (413). The editor shows it from 1 MiB and does not send (design v2 4.4). */
export const MAX_BODY_BYTES = 1024 * 1024;
export type Snapshot = {
  chip: Chip;
  /** The text for the chip: the version of a saved memo, the reason of a pending one, the message of a refused one. */
  detail: string | null;
  id: string | null;
  version: number | null;
  dirty: boolean;
  /** Nothing to save, or no way to save now. */
  canSave: boolean;
  hits: readonly Hit[];
  hitsFrom: 'precheck' | 'kb' | null;
  /** "비밀 아님 · 격리 보관" is for a create the KB refused. */
  canQuarantine: boolean;
  conflict: { current: Current; mine: string } | null;
  failed: { ref: string; code: string | null } | null;
  mode: 'plain' | 'secret';
  /** The editor is loaded from `initial` again whenever `epoch` changes: that is how text and undo history are cleared. */
  editor: { initial: string; epoch: number };
  /** The memo was quarantined: nothing of it is left to show. */
  quarantinedAt: string | null;
  /** The KB takes no `private` record yet (`/v1/meta.write.private_open` is false): nothing is sent. */
  closed: boolean;
  /** The text is 1 MiB or more: nothing is sent. */
  large: boolean;
  /** `Note` for a memo, `Page` for a document; the sensitivity the record carries (a document made `internal` keeps it). */
  kind: 'Note' | 'Page';
  sensitivity: 'private' | 'internal';
};

export type Deps = {
  /** What is saved: a memo (default) or a document. The path, the keys and the checks are the same. */
  kind?: 'Note' | 'Page';
  post: (path: string, body: unknown) => Promise<WriteResult>;
  readRef: (ref: string) => Promise<RefState>;
  discard: (ref: string) => Promise<boolean>;
  precheck: () => Precheck | null;
  /** `/v1/meta.write.private_open` is not false. */
  privateOpen: () => boolean;
  now: () => Date;
  uuid: () => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  track: { changed: () => void; write: (ref: string) => void; unwrite: (ref: string) => void; rejected: (e: { record: string; rule: string; at: string }) => void; unrejected: (record: string) => void };
};

type Attempt = { key: string; kind: 'create' | 'edit'; expected: number | null; content: string; sha: string };
const RETRY_MS = [2000, 5000, 15_000, 30_000];
const POLL_MS = [1000, 2000, 45_000];
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export class Saver {
  private content = '';
  private savedContent: string | null = null;
  private id: string | null = null;
  private version: number | null = null;
  private lastOk: { version: number; unchanged: boolean } | null = null;
  private createKey: string;
  private attempt: Attempt | null = null;
  /** An earlier send whose answer never came, when another text has been sent since: the KB may have kept it (5.2 "자기 저장 인식"). */
  private lost: Attempt | null = null;
  private revs = new Map<number, number>();
  private net: Net | null = null;
  private preHits: Hit[] = [];
  private kbHits: Hit[] = [];
  private kbHitsFor: string | null = null;
  private anywayFor: string | null = null;
  private quarantineNext = false;
  private conflict: { current: Current; mine: string } | null = null;
  private pending: { ref: string; content: string; reason: string } | null = null;
  private failed: { ref: string; code: string | null; content: string } | null = null;
  private running = false;
  private wantSave = false;
  private retryHandle: unknown = null;
  private retryCount = 0;
  private pollHandle: unknown = null;
  private pollCount = 0;
  private mode: 'plain' | 'secret' = 'plain';
  private editor = { initial: '', epoch: 0 };
  private quarantinedAt: string | null = null;
  private disposed = false;
  private props: Record<string, unknown> = {};
  private sensitivity: 'private' | 'internal' = 'private';
  private listeners = new Set<() => void>();
  private snap: Snapshot;

  private deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
    this.createKey = `loupe:c:${deps.uuid()}`;
    this.snap = this.build();
  }

  // ---- reading
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = (): Snapshot => this.snap;

  private get dirty() { return this.content !== (this.savedContent ?? ''); }
  private get kind() { return this.deps.kind ?? 'Note'; }
  private get stamp() { return this.kind === 'Page' ? '문서' : '메모'; }
  private get large() { return this.content.length * 4 >= MAX_BODY_BYTES && new TextEncoder().encode(this.content).length >= MAX_BODY_BYTES; }
  private build(): Snapshot {
    const dirty = this.dirty;
    const anyway = this.anywayFor !== null && this.anywayFor === this.content;
    let chip: Chip, detail: string | null = null;
    if (this.quarantinedAt) chip = 'quarantined';
    else if (this.conflict) chip = 'conflict';
    else if (this.failed) { chip = 'failed'; detail = this.failed.code; }
    else if (this.pending) { chip = 'pending'; detail = this.pending.reason; }
    else if (this.running) chip = 'saving';
    else if (!this.deps.privateOpen()) chip = 'closed';
    else if (this.large) chip = 'large';
    else if (this.kbHits.length) chip = 'rejected';
    else if (this.preHits.length && !anyway) chip = 'blocked';
    else if (this.net) { chip = this.net.kind; if (this.net.kind === 'invalid') detail = this.net.message; }
    else if (dirty) chip = 'dirty';
    else if (this.lastOk) { chip = this.lastOk.unchanged ? 'unchanged' : 'saved'; detail = `v${this.lastOk.version}`; }
    else chip = 'empty';
    const hits = this.kbHits.length ? this.kbHits : this.preHits;
    const large = this.large;
    const stopped = !!this.quarantinedAt || !!this.conflict || !!this.failed || this.mode === 'secret' || !this.deps.privateOpen() || large;
    return {
      chip, detail, id: this.id, version: this.version, dirty: dirty || !!this.pending || !!this.failed || this.running,
      canSave: !stopped && dirty && !this.running && !this.pending && (!this.preHits.length || anyway) && !this.kbHits.length,
      hits, hitsFrom: this.kbHits.length ? 'kb' : this.preHits.length ? 'precheck' : null,
      canQuarantine: this.kbHits.length > 0 && this.id === null && !this.quarantinedAt,
      conflict: this.conflict, failed: this.failed ? { ref: this.failed.ref, code: this.failed.code } : null,
      mode: this.mode, editor: this.editor, quarantinedAt: this.quarantinedAt, closed: !this.deps.privateOpen(),
      large, kind: this.kind, sensitivity: this.sensitivity,
    };
  }
  private emit() { if (this.disposed) return; this.snap = this.build(); this.listeners.forEach((l) => l()); }
  /** The text the person sees as the editor's, for a window that has to put it on screen again (a failed write's copy). */
  text = () => this.content;

  // ---- a record that exists
  /**
   * A document opened from the KB: the save then goes on that record, on the version the window saw, and keeps its `props` and `sensitivity`
   * (a PUT replaces the record, so a field left out would be lost). Refused when the window already holds a record or unsaved text.
   */
  load(r: { id: string; version: number; body: string; props?: Record<string, unknown>; sensitivity?: string }): boolean {
    if (this.id !== null || this.dirty || this.pending || this.quarantinedAt) return false;
    this.id = r.id; this.version = r.version; this.content = r.body; this.savedContent = r.body; this.lastOk = null;
    this.props = r.props ?? {};
    this.sensitivity = r.sensitivity === 'internal' ? 'internal' : 'private';
    this.editor = { initial: r.body, epoch: this.editor.epoch + 1 };
    this.scan(); this.emit();
    return true;
  }

  // ---- text in
  /** The window's text changed. Runs the precheck at once: a match blocks the save and shows its ranges. */
  setContent(markdown: string) {
    if (this.quarantinedAt || markdown === this.content) return;
    this.content = markdown;
    if (this.kbHitsFor !== null && this.kbHitsFor !== markdown) { this.kbHits = []; this.kbHitsFor = null; }
    if (this.net?.kind === 'invalid' || this.net?.kind === 'throttled') this.net = null;
    this.scan();
    this.emit();
  }
  private scan() {
    const pre = this.deps.precheck();
    this.preHits = pre && this.content ? pre.scan(recordFields({ record: { title: titleOf(this.content, this.deps.now(), this.stamp), body: this.content } })) : [];
  }
  /** The precheck was turned on or off (the rule set of the KB was read). */
  recheck() { this.scan(); this.emit(); }

  // ---- saving
  /** Ask for a save. `anyway` is "일반으로 보내기": the person says the matched span is not a secret, for this text only. */
  async save(o: { anyway?: boolean } = {}) {
    if (this.quarantinedAt || this.conflict || this.failed || this.mode === 'secret' || !this.deps.privateOpen() || this.large) return;
    if (!this.dirty) return;
    if (o.anyway) this.anywayFor = this.content;
    this.wantSave = true;
    this.clearRetry();
    await this.pump();
  }
  private async pump() {
    if (this.running || this.pending) { this.emit(); return; }
    this.running = true; this.emit();
    try {
      while (this.wantSave && !this.pending && !this.disposed) {
        this.wantSave = false;
        await this.sendOnce();
      }
    } finally { this.running = false; this.emit(); }
  }

  private async sendOnce() {
    const content = this.content;
    if (!(content !== (this.savedContent ?? ''))) return;
    this.scan();
    if (this.preHits.length && this.anywayFor !== content) return;
    const record: NoteRecord = { type: this.kind, title: titleOf(content, this.deps.now(), this.stamp), body: content, body_format: 'markdown', sensitivity: this.sensitivity, props: this.props, links: [] };
    const sha = await payloadSha(record);
    const kind: Attempt['kind'] = this.id ? 'edit' : 'create';
    let key: string, expected: number | null = null;
    if (kind === 'create') key = this.createKey;
    else {
      expected = this.version!;
      const same = this.attempt && this.attempt.kind === 'edit' && this.attempt.expected === expected && this.attempt.content === content;
      if (same) key = this.attempt!.key;
      else { const r = (this.revs.get(expected) ?? 0) + 1; this.revs.set(expected, r); key = `loupe:e:${this.id}:v${expected}:save:r${r}`; }
    }
    const attempt: Attempt = { key, kind, expected, content, sha };
    if (this.attempt && this.attempt.content !== content) this.lost = this.attempt;
    this.attempt = attempt;
    const quarantine = this.quarantineNext && kind === 'create';
    const body = kind === 'create'
      ? { idempotency_key: key, change: 'save', ...(quarantine ? { on_secret: 'quarantine' } : {}), record }
      : { idempotency_key: key, change: 'save', expected_version: expected, record };
    this.net = null; this.emit();
    const result = await this.deps.post(kind === 'create' ? '/records' : `/records/${encodeURIComponent(this.id!)}`, body);
    if (this.disposed) return;
    await this.settle(result, attempt);
  }

  private async settle(r: WriteResult, a: Attempt) {
    if (r.t === 'network') {
      this.net = { kind: 'offline' };
      const delay = RETRY_MS[Math.min(this.retryCount++, RETRY_MS.length - 1)]!;
      this.retryLater(delay);
      return;
    }
    this.retryCount = 0;
    const lost = this.lost;
    this.lost = null;
    if (r.t === 'ok') { await this.accepted(r, a); return; }
    const { status, code, body } = r;
    if (status === 422 && code === 'secret_detected') { await this.refused(body, a); return; }
    if (status === 409) { await this.conflicted(body, a, lost); return; }
    this.attempt = null;
    if (status === 401) { this.net = code === 'session_required' ? { kind: 'session' } : { kind: 'token' }; return; }
    if (status === 503 && code === 'token_not_configured') { this.net = { kind: 'token' }; return; }
    if (status === 403 && code === 'sensitivity_not_allowed') { this.net = { kind: 'closed' }; return; }
    if (status === 429 || (status === 503 && (code === 'gate_busy' || code === 'spool_full'))) {
      const sec = r.retryAfterSec ?? 5;
      this.net = { kind: 'throttled', retryAt: this.deps.now().getTime() + sec * 1000 };
      this.attempt = a;
      this.retryLater(sec * 1000);
      return;
    }
    this.net = { kind: 'invalid', message: status === 404 ? '없거나 볼 수 없다' : code ?? `HTTP ${status}` };
  }

  private async accepted(r: Extract<WriteResult, { t: 'ok' }>, a: Attempt) {
    const b = r.body;
    const id = typeof b.id === 'string' ? b.id : this.id;
    if (b.quarantined === true) { this.quarantined(id, b, a); return; }
    if (r.status === 202) {
      const ref = typeof b.write_ref === 'string' ? b.write_ref : null;
      if (!ref) { this.net = { kind: 'invalid', message: '대기 번호가 없는 202' }; return; }
      this.id = this.id ?? id;
      this.attempt = null;
      this.pending = { ref, content: a.content, reason: b.held === true ? '보관 경로가 없다' : '쓰기 관문이 느리다' };
      this.deps.track.write(ref);
      this.pollCount = 0;
      this.pollLater();
      return;
    }
    this.commit(id, typeof b.version === 'number' ? b.version : null, a.content, b.unchanged === true);
  }
  private commit(id: string | null, version: number | null, content: string, unchanged: boolean) {
    this.id = id ?? this.id;
    if (version !== null) this.version = version;
    this.savedContent = content;
    this.lastOk = this.version !== null ? { version: this.version, unchanged } : null;
    this.attempt = null; this.net = null; this.kbHits = []; this.kbHitsFor = null; this.anywayFor = null; this.quarantineNext = false;
    if (this.id) this.deps.track.unrejected(this.id);
  }

  private async refused(b: Record<string, unknown>, a: Attempt) {
    const hits = Array.isArray(b.hits) ? b.hits.map(rec).filter((h): h is Hit => typeof h.rule === 'string' && typeof h.field === 'string') : [];
    // The KB's word on it: the ranges it gives are in the text that was sent, so they hold only while the text is that text.
    this.kbHits = hits; this.kbHitsFor = a.content; this.attempt = null; this.anywayFor = null; this.quarantineNext = false;
    const record = this.id ?? (a.kind === 'create' ? await deriveRecordId(a.key) : null);
    const rule = hits[0]?.rule;
    if (record && rule && /^[A-Za-z0-9_.-]{1,64}$/.test(rule)) this.deps.track.rejected({ record, rule, at: this.deps.now().toISOString() });
  }

  private quarantined(id: string | null, b: Record<string, unknown>, a: Attempt) {
    const warnings = Array.isArray(b.warnings) ? b.warnings.filter((w): w is string => typeof w === 'string') : [];
    const rule = /^secret_detected:([A-Za-z0-9_.-]{1,64})/.exec(warnings[0] ?? '')?.[1] ?? this.kbHits[0]?.rule ?? 'secret_detected';
    if (a.kind === 'create') void this.derivedFor(a.key).then((d) => { if (d && d !== id) this.deps.track.unrejected(d); });
    if (id) this.deps.track.rejected({ record: id, rule, at: this.deps.now().toISOString() });
    // Nothing of the text stays here, and the editor is not given the text back (5.5): the window closes on this.
    this.content = ''; this.savedContent = null; this.attempt = null; this.kbHits = []; this.kbHitsFor = null; this.preHits = []; this.anywayFor = null;
    this.quarantineNext = false; this.id = null; this.version = null; this.lastOk = null; this.net = null;
    this.editor = { initial: '', epoch: this.editor.epoch + 1 };
    this.quarantinedAt = this.deps.now().toISOString();
  }
  /** The text that was refused is gone from the window, so the refusal is no longer news for the task list. */
  private async cleanRejected() { const id = this.id ?? await this.derivedFor(this.createKey); if (id) this.deps.track.unrejected(id); }
  private async derivedFor(key: string): Promise<string | null> { try { return await deriveRecordId(key); } catch { return null; } }

  private async conflicted(b: Record<string, unknown>, a: Attempt, lost: Attempt | null) {
    const c = rec(b.current);
    if (typeof c.version !== 'number') { this.attempt = null; this.net = { kind: 'invalid', message: typeof b.code === 'string' ? b.code : 'HTTP 409' }; return; }
    const current: Current = {
      version: c.version, status: typeof c.status === 'string' ? c.status : 'active', payloadSha: typeof c.payload_sha === 'string' ? c.payload_sha : null,
      body: typeof c.body === 'string' ? c.body : '', actor: typeof c.actor === 'string' ? c.actor : null,
    };
    const own = current.payloadSha === null ? null : [a, lost].find((x): x is Attempt => !!x && x.sha === current.payloadSha) ?? null;
    if (own) {
      // My own earlier save, whose answer I never got (5.2 "자기 저장 인식"): build on it, and send what came after it.
      this.id = this.id ?? (a.kind === 'create' ? await deriveRecordId(a.key) : null);
      this.version = current.version; this.savedContent = own.content; this.lastOk = { version: current.version, unchanged: false };
      this.attempt = null; this.net = null;
      if (this.id) this.deps.track.unrejected(this.id);
      if (this.content !== own.content) this.wantSave = true;
      return;
    }
    this.attempt = null;
    this.conflict = { current, mine: a.content };
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
    if (s !== 'gone' && s.state === 'committed') {
      this.pending = null;
      this.commit(s.id, s.version, p.content, false);
      this.deps.track.unwrite(p.ref);
      this.emit();
      if (this.dirty) void this.save();
      return;
    }
    if (s !== 'gone' && s.state === 'failed') { this.pending = null; this.failed = { ref: p.ref, code: s.code, content: p.content }; this.deps.track.changed(); this.emit(); return; }
    // purged or gone: the KB no longer has it. The text is still in the window and still unsaved.
    this.pending = null; this.deps.track.unwrite(p.ref); this.emit();
  }
  /** The person throws a failed write away (5.2). The text stays in the window. A create takes a new key: the old one belongs to the thrown write. */
  async discardFailed() {
    const f = this.failed;
    if (!f) return;
    if (!(await this.deps.discard(f.ref))) return;
    this.failed = null;
    this.deps.track.unwrite(f.ref);
    if (!this.savedContent && this.version === null) { this.createKey = `loupe:c:${this.deps.uuid()}`; this.id = null; }
    this.emit();
  }
  /** What the window gives the person to copy before discarding. */
  failedText = () => this.failed?.content ?? this.content;

  // ---- ways out of a refusal
  /** "비밀 아님 · 격리 보관": the same create key and text, with `on_secret: "quarantine"` (5.5). */
  async quarantine() {
    if (!this.snap.canQuarantine) return;
    this.quarantineNext = true; this.anywayFor = this.content; this.wantSave = true;
    await this.pump();
  }
  /** "보안 정보로 바꾸기" / "고치기 (구간 지우기)": the text without the matched spans, in a new editor with no history. Returns the text. */
  removeMatches(): string {
    const spans = this.snap.hits.filter((h) => h.field === 'record.body').map((h) => [h.start_u16, h.end_u16] as const).sort((a, b) => b[0] - a[0]);
    let out = this.content;
    for (const [s, e] of spans) out = out.slice(0, s) + out.slice(e);
    this.replace(out);
    return out;
  }
  /** The text in the window becomes `markdown`; the editor is built again from it, and nothing earlier can be undone. */
  replace(markdown: string) {
    if (this.kbHits.length) void this.cleanRejected();
    this.content = markdown; this.kbHits = []; this.kbHitsFor = null; this.attempt = null; this.anywayFor = null; this.quarantineNext = false;
    this.net = null;
    this.editor = { initial: markdown, epoch: this.editor.epoch + 1 };
    this.scan(); this.emit();
  }
  /** The matched spans as text, for painting. They live in this call only. */
  matched(): string[] {
    return [...new Set(this.snap.hits.filter((h) => h.field === 'record.body').map((h) => this.content.slice(h.start_u16, h.end_u16)).filter(Boolean))];
  }
  /** 일반 / 보안 정보 (5.7). The secret side never takes text: what was typed is dropped, with the undo history. Only before the first save. */
  setMode(mode: 'plain' | 'secret') {
    if (mode === this.mode || this.id !== null || this.pending || this.quarantinedAt) return;
    this.mode = mode;
    this.content = ''; this.attempt = null; this.kbHits = []; this.kbHitsFor = null; this.preHits = []; this.anywayFor = null; this.net = null;
    this.editor = { initial: '', epoch: this.editor.epoch + 1 };
    this.emit();
  }

  // ---- conflict (5.3)
  /** "내 것으로 덮어쓰기": my text on top of the other side's version. */
  async keepMine() {
    const c = this.conflict;
    if (!c) return;
    this.id = this.id ?? await deriveRecordId(this.createKey);
    this.version = c.current.version; this.conflict = null; this.wantSave = true;
    this.savedContent = this.savedContent ?? '';
    await this.pump();
  }
  /** "저쪽 것 가져오기": the other side's text replaces mine. Returns it for the editor. */
  async takeTheirs(): Promise<string | null> {
    const c = this.conflict;
    if (!c) return null;
    this.id = this.id ?? await deriveRecordId(this.createKey);
    this.version = c.current.version; this.conflict = null; this.savedContent = c.current.body;
    this.lastOk = { version: c.current.version, unchanged: false };
    this.replace(c.current.body);
    return c.current.body;
  }
  /** "둘 다": mine, then the other side's, on top of the other side's version. Returns the text for the editor. */
  async keepBoth(): Promise<string | null> {
    const c = this.conflict;
    if (!c) return null;
    this.id = this.id ?? await deriveRecordId(this.createKey);
    this.version = c.current.version; this.conflict = null; this.savedContent = c.current.body;
    const merged = `${c.mine.trimEnd()}\n\n${c.current.body.trim()}\n`;
    this.replace(merged);
    return merged;
  }

  // ---- timers
  private retryLater(ms: number) {
    this.clearRetry();
    this.retryHandle = this.deps.setTimer(() => { this.retryHandle = null; this.wantSave = true; void this.pump(); }, ms);
  }
  private clearRetry() { if (this.retryHandle !== null) { this.deps.clearTimer(this.retryHandle); this.retryHandle = null; } }
  dispose() {
    this.disposed = true; this.clearRetry();
    if (this.pollHandle !== null) { this.deps.clearTimer(this.pollHandle); this.pollHandle = null; }
    this.listeners.clear();
  }
}
