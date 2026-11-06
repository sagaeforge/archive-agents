// The body of a memo window (design v2 2.5, 5.2, 5.3, 5.5, 5.7, 5.9, 9). Default export so the shell can load it with React.lazy: this file, the
// editor and the save machine form one chunk the first screen never fetches. The window is a local one (memo/id.ts); the text and the save state
// live in the draft (drafts.ts), so hiding the window (내리기) or re-rendering it loses nothing.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownEditor, type EditorHandle } from '../editor/MarkdownEditor.tsx';
import kbFetch from '../data/kbFetch.ts';
import { TASKS_KEY } from '../tasks/useTasks.ts';
import { windows } from '../wm/opener.ts';
import { isComposing } from '../wm/model.ts';
import { draftFor, hooks, memoEnv } from './drafts.ts';
import { precheckFor, type PrecheckState } from './rules.ts';
import type { Chip, Snapshot } from './saver.ts';
import { memoStore, useMemoInfos } from './store.ts';
import { titleOf } from './title.ts';
import './memo.css';

type Meta = { data?: { write?: { private_open?: unknown; secret_rules?: unknown } } };
const CHIP: Record<Chip, (s: Snapshot) => string> = {
  empty: () => '', dirty: () => '저장 안 됨', saving: () => '저장 중', saved: (s) => `저장됨 ${s.detail}`, unchanged: (s) => `변경 없음 ${s.detail}`,
  pending: (s) => `보내는 중 · ${s.detail}`, failed: () => '저장 실패', blocked: () => '저장 전 검사에 걸림', rejected: () => '저장 거절', conflict: () => '충돌',
  quarantined: () => '격리 보관', offline: () => '끊김 · 다시 보내는 중', token: () => 'KB 쓰기 권한 없음', session: () => '로그인이 필요하다',
  closed: () => 'KB가 아직 비공개 기록을 받지 않는다', throttled: () => '저장이 잠시 밀렸다', invalid: (s) => `저장 거절 · ${s.detail}`,
  large: () => '본문이 1 MiB를 넘어 저장할 수 없다',
};
const FIELD = (f: string) => (f === 'record.title' ? '제목' : f === 'record.body' ? '본문' : '속성');

/** What a document adds around the body (src/doc/DocWindow.tsx). `viewing` is an older version: while it is set, the editor stays mounted but hidden, so its undo history survives. */
export type Slots = { head?: ReactNode; tabs?: ReactNode; viewing?: ReactNode };

/** One window for a memo (`Note`) and for a document (`Page`): the same text, save machine, checks and bands (design v2 11.3 M2 reuses the M1 path). */
export default function MemoWindow({ id, onClose, onOpenSettings, kind = 'Note', slots, focus = true }: { id: string; onClose: () => void; onOpenSettings: () => void; kind?: 'Note' | 'Page'; slots?: Slots; focus?: boolean }) {
  const doc = kind === 'Page';
  const name = doc ? '문서' : '메모';
  const qc = useQueryClient();
  const saver = useMemo(() => draftFor(id, kind), [id, kind]);
  const snap = useSyncExternalStore(saver.subscribe, saver.get);
  const handle = useRef<EditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const [replaced, setReplaced] = useState(false);
  const [copied, setCopied] = useState(false);
  const info = useMemoInfos().get(id);

  useEffect(() => { hooks.registryChanged = () => { void qc.invalidateQueries({ queryKey: TASKS_KEY }); }; }, [qc]);

  // The KB says which secret rule set it runs and whether it takes `private` records (5.6, 5.7). Read once for the page, then with the 45 s meta poll.
  const meta = useQuery({ queryKey: ['loupe', 'memo', 'meta'], queryFn: () => kbFetch<Meta>('/v1/meta'), staleTime: 30_000 });
  const [rules, setRules] = useState<PrecheckState>({ check: memoEnv.precheck, status: 'unknown' });
  const write = meta.data?.data?.write;
  const remote = meta.data ? write?.secret_rules ?? null : undefined;
  useEffect(() => {
    let live = true;
    void precheckFor(remote).then((p) => { if (!live) return; memoEnv.precheck = p.check; setRules(p); saver.recheck(); });
    return () => { live = false; };
  }, [remote, saver]);
  const closed = !!meta.data && write?.private_open === false;
  useEffect(() => { memoEnv.privateOpen = !closed; saver.recheck(); }, [closed, saver]);

  // What the shell shows for this window: the dock chip, the title and the "저장 안 됨". A window with a matched span names no title.
  const text = saver.text();
  const label = snap.hits.length > 0 || !text.trim() ? name : titleOf(text, new Date(), name);
  useEffect(() => { memoStore.set(id, { dirty: snap.dirty, label }); }, [id, snap.dirty, label]);

  // Closing or leaving the tab with text that is not in the KB asks first (2.7, 5.2).
  useEffect(() => {
    if (!snap.dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [snap.dirty]);

  // The matched spans are painted, never copied anywhere: they are rebuilt from the draft on each render.
  const matched = snap.hits.length > 0 ? saver.matched() : [];
  const maskKey = matched.join('\u0000');
  const mask = useMemo(() => matched, [maskKey]);

  // The locked secret side has no text field: the focus rests on the window itself, so Alt+S still reaches it.
  useEffect(() => { if (snap.mode === 'secret') root.current?.focus({ preventScroll: true }); }, [snap.mode]);

  const flush = useCallback(() => { const md = handle.current?.markdown(); if (md !== undefined) saver.setContent(md); }, [saver]);
  const save = useCallback(async (o?: { anyway?: boolean }) => { flush(); setReplaced(false); await saver.save(o); }, [flush, saver]);
  const saveAndClose = useCallback(async () => {
    await save();
    const s = saver.get();
    if (!s.dirty && (s.chip === 'saved' || s.chip === 'unchanged')) onClose();
  }, [save, saver, onClose]);
  useEffect(() => { if (snap.quarantinedAt) onClose(); }, [snap.quarantinedAt, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(e.nativeEvent)) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (mod && e.key === 'Enter' && !doc) { e.preventDefault(); void saveAndClose(); }
    else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS' && !doc) { e.preventDefault(); if (snap.id === null) saver.setMode(snap.mode === 'plain' ? 'secret' : 'plain'); }
  };

  // A button of this window does not take the focus from the text: typing goes on where it was.
  const keepFocus = (e: MouseEvent<HTMLElement>) => e.preventDefault();
  const rulesOff = rules.status !== 'unknown' && !rules.status.on;
  const ruleIds = [...new Set(snap.hits.map((h) => `${h.rule} (${FIELD(h.field)})`))];
  const fromKb = snap.hitsFrom === 'kb';

  // The editor starts from the draft's own text, so a window that was unmounted and mounted again (the edit toggle of a record) finds its work.
  const startText = useMemo(() => saver.text(), [saver, snap.editor.epoch]);

  return <div className="memo" ref={root} tabIndex={-1} data-testid={doc ? 'doc-window' : 'memo-window'} data-status={snap.chip} data-id={id} onKeyDown={onKeyDown}>
    <div className="memo-head">
      {!doc && <div className="memo-mode" role="group" aria-label="분류">
        <button type="button" data-testid="memo-mode-plain" aria-pressed={snap.mode === 'plain'} disabled={snap.id !== null} onMouseDown={keepFocus} onClick={() => saver.setMode('plain')}>일반</button>
        <button type="button" data-testid="memo-mode-secret" aria-pressed={snap.mode === 'secret'} disabled={snap.id !== null} onMouseDown={keepFocus} onClick={() => saver.setMode('secret')} title="Alt+S">보안 정보</button>
      </div>}
      <span className="memo-private" data-testid="memo-private">{snap.sensitivity === 'internal' ? 'internal · Claude 세션이 읽는다' : 'private · loupe만'}</span>
      {slots?.head}
      <span className="memo-chip" data-testid="memo-chip" data-kind={snap.chip} role="status" aria-live="polite">{CHIP[snap.chip](snap)}</span>
      <button type="button" className="memo-save" data-testid="memo-save" disabled={!snap.canSave} onMouseDown={keepFocus} onClick={() => void save()} title="Ctrl+S">저장</button>
    </div>

    {info?.askClose && <section className="memo-band" data-tone="warn" data-testid="memo-close-ask" role="alert">
      <strong>저장하지 않은 글이 있다</strong>
      <div className="memo-actions">
        <button type="button" data-testid="memo-close-save" onClick={() => void saveAndClose().finally(() => memoStore.set(id, { askClose: false }))}>저장하고 닫기</button>
        <button type="button" data-testid="memo-close-discard" onClick={onClose}>버리고 닫기</button>
        <button type="button" data-testid="memo-close-cancel" onClick={() => memoStore.set(id, { askClose: false })}>취소</button>
      </div>
    </section>}

    {rulesOff && <section className="memo-band" data-tone="warn" data-testid="memo-precheck-off" role="status">
      <strong>비밀 사전 검사 꺼짐: 규칙 판이 다르다</strong>KB의 검사는 그대로 켜져 있다.
    </section>}
    {snap.closed && <section className="memo-band" data-tone="warn" data-testid="memo-closed" role="status">
      <strong>KB가 아직 비공개 기록을 받지 않는다</strong>쓴 글은 이 창에 남고 아무것도 보내지 않는다.
    </section>}
    {snap.chip === 'token' && <section className="memo-band" data-tone="error" data-testid="memo-token" role="alert">
      <strong>KB 쓰기 권한 없음, 토큰 다시 설정</strong>초안은 이 창에 있다. 설정 → KB 상태에서 토큰을 다시 설정한 뒤 저장한다.
      <div className="memo-actions"><button type="button" data-testid="memo-open-settings" onClick={onOpenSettings}>설정 열기</button></div>
    </section>}
    {snap.chip === 'session' && <section className="memo-band" data-tone="warn" data-testid="memo-session" role="alert">
      <strong>로그인이 필요하다</strong>초안은 이 창에 있다. 다시 로그인한 뒤 저장한다.
    </section>}
    {snap.chip === 'throttled' && <section className="memo-band" data-tone="warn" role="status"><strong>저장이 잠시 밀렸다</strong>곧 같은 내용을 다시 보낸다.</section>}

    {snap.hitsFrom && <section className="memo-band" data-tone="error" data-testid="memo-secret" data-source={fromKb ? 'kb' : 'precheck'} role="alert">
      <strong>{fromKb ? '저장 거절 · KB가 비밀로 보았다' : '저장 전 검사에 걸림'}</strong>
      <ul>{ruleIds.map((r) => <li key={r}>규칙 {r}</li>)}</ul>
      {fromKb ? '저장된 곳이 없다. 저장 전 검사가 놓친 것이다.' : '칠한 구간은 보내지 않았다.'}
      <div className="memo-actions">
        <button type="button" data-testid="memo-to-secret" onClick={() => { saver.removeMatches(); setReplaced(true); }}>보안 정보로 바꾸기</button>
        <button type="button" data-testid="memo-fix" onClick={() => handle.current?.focus()}>고치기</button>
        {!fromKb && <button type="button" data-testid="memo-send-anyway" onClick={() => void save({ anyway: true })}>일반으로 보내기</button>}
        {fromKb && snap.canQuarantine && <button type="button" data-testid="memo-quarantine" onClick={() => void saver.quarantine()}>비밀 아님 · 격리 보관</button>}
      </div>
    </section>}
    {replaced && !snap.hitsFrom && <section className="memo-band" data-testid="memo-secret-note" role="status">
      <strong>칠한 구간을 지웠다</strong>보안 정보는 비밀 창에서 넣는다. 비밀 창은 KMS가 연결된 뒤에 열린다.
      <div className="memo-actions"><button type="button" data-testid="memo-open-secret-note" disabled title="KMS 연결 뒤">비밀 창 열기</button><button type="button" onClick={() => setReplaced(false)}>닫기</button></div>
    </section>}

    {snap.conflict && <section className="memo-band" data-tone="error" data-testid="memo-conflict" role="alert">
      <strong>다른 곳에서 v{snap.conflict.current.version}으로 바뀌었다{snap.conflict.current.actor ? ` · ${snap.conflict.current.actor}` : ''}</strong>
      {snap.conflict.current.status === 'dead' ? '다른 곳에서 보관됨' : <div className="memo-cols">
        <div><small>내 것</small><pre>{snap.conflict.mine}</pre></div>
        <div><small>저쪽</small><pre>{snap.conflict.current.body}</pre></div>
      </div>}
      <div className="memo-actions">
        <button type="button" data-testid="memo-keep-mine" onClick={() => void saver.keepMine()}>내 것으로 덮어쓰기</button>
        {snap.conflict.current.status !== 'dead' && <>
          <button type="button" data-testid="memo-take-theirs" onClick={() => void saver.takeTheirs()}>저쪽 것 가져오기</button>
          <button type="button" data-testid="memo-both" onClick={() => void saver.keepBoth()}>둘 다</button>
        </>}
      </div>
    </section>}

    {snap.failed && <section className="memo-band" data-tone="error" data-testid="memo-failed" role="alert">
      <strong>저장 실패 · {snap.failed.code ?? '이유 알 수 없음'}</strong>KB가 보낸 글을 쓰지 못했다. 내 글은 이 창에 있다.
      <div className="memo-actions">
        <button type="button" data-testid="memo-copy" onClick={() => { void navigator.clipboard.writeText(saver.failedText()).then(() => setCopied(true), () => setCopied(false)); }}>내 사본 복사</button>
        <button type="button" data-testid="memo-discard" onClick={() => void saver.discardFailed()}>버리기</button>
        {copied && <span role="status">복사했다</span>}
      </div>
    </section>}

    {slots?.tabs}
    <div className="memo-body" hidden={!!slots?.viewing}>
      {snap.mode === 'secret'
        ? <div className="memo-locked" data-testid="memo-secret-locked">
          <p>보안 정보는 비밀 창에서 넣는다 → 비밀 창 열기</p>
          <p><small>여기서 쓴 글은 KB로 가지 않는다. 비밀 창은 KMS가 연결된 뒤에 열린다.</small></p>
          <button type="button" data-testid="memo-open-secret" disabled title="KMS 연결 뒤">비밀 창 열기</button>
        </div>
        // A document keeps its "원문 Markdown" copy of the text, except while a matched span is on screen: that copy would draw the value again (5.5).
        : !snap.quarantinedAt && <MarkdownEditor key={snap.editor.epoch} markdown={startText} label={name} hideSource={!doc || snap.hitsFrom !== null} autoFocus={focus} handleRef={handle} mask={mask}
          onChange={(md) => saver.setContent(md)} doc={doc} {...(doc ? { onOpenLink: windows.open } : {})} />}
    </div>
    {slots?.viewing}
  </div>;
}
