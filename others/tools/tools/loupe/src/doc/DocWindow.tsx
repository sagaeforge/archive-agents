// The body of a document window (design v2 11.3 M2, 2.7, 4.2, 4.4, 5.3). Default export so the shell loads it with React.lazy: this file, the memo window,
// the editor and the save machine form chunks the first screen never fetches.
//
// It is the memo window with a document's extras: `MemoWindow kind="Page"` keeps the text, the save path and every band of M1; this file adds the
// version tabs (an older version is shown read-only, the live editor stays mounted behind it so its undo history is kept), "이 판으로 되돌리기" (a new version
// with the old text), "보관" (a tombstone), and, for a record opened from the KB, the loading of its body into the save machine.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageRoot } from '../components/PageRoot.tsx';
import { Loading } from '../components/bits.tsx';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import kbFetch from '../data/kbFetch.ts';
import { useNodeDetail } from '../data/hooks.ts';
import type { NodeDetail, VersionRow } from '../client/model/index.ts';
import { draftFor } from '../memo/drafts.ts';
import MemoWindow from '../memo/MemoWindow.tsx';
import { SETTINGS_ID } from '../settings/id.ts';
import { DbScope } from '../db/scope.ts';
import { windows } from '../wm/opener.ts';
import { isDocWindow } from './id.ts';
import { archive } from './records.ts';
import './doc.css';

type Props = { id: string; onClose?: () => void; onOpenSettings?: () => void };
const enc = encodeURIComponent;

/** `id` is the window's id: a document made in this tab (`loupe:doc:…`), or the id of a record of the KB. */
export default function DocWindow(props: Props) {
  return isDocWindow(props.id) ? <DocBody {...props} /> : <ExistingDoc {...props} />;
}

function ExistingDoc(props: Props) {
  const { id } = props;
  const q = useNodeDetail(id, {});
  const node = q.data?.data;
  const [ready, setReady] = useState(() => draftFor(id, 'Page').get().id !== null);
  const partial = !!node && (node.body_chars ?? (node.body ?? '').length) > (node.body ?? '').length;
  useEffect(() => {
    if (!node || partial || ready) return;
    // A window that has its record already (the edit toggle was pressed twice) keeps the text it has; `load` refuses to go over it.
    draftFor(id, 'Page').load({ id, version: node.version, body: node.body ?? '', props: node.props as Record<string, unknown>, sensitivity: node.sensitivity });
    setReady(true);
  }, [node, partial, ready, id]);
  if (q.isError) return <PageRoot className="page window-entity"><p role="alert">본문을 읽지 못했다</p></PageRoot>;
  if (!node) return <PageRoot className="page window-entity"><Loading /></PageRoot>;
  // A body read in parts must not be opened as if it were whole: the rest would be lost on a later save.
  if (partial) return <PageRoot className="page window-entity" data-testid="editor-partial"><p role="status">본문이 길어 여기서는 편집하지 않는다</p></PageRoot>;
  return ready ? <DocBody {...props} existing /> : <PageRoot className="page window-entity"><Loading /></PageRoot>;
}

type History = { data: { versions: VersionRow[] } };

function DocBody({ id, onClose = () => windows.close(id), onOpenSettings = () => windows.open(SETTINGS_ID), existing = false }: Props & { existing?: boolean }) {
  const qc = useQueryClient();
  const saver = draftFor(id, 'Page');
  const snap = useSyncExternalStore(saver.subscribe, saver.get);
  const record = snap.id;
  const [view, setView] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const history = useQuery({
    queryKey: ['loupe', 'doc', 'history', record, snap.version], enabled: !!record && snap.version !== null, staleTime: 0,
    queryFn: () => kbFetch<History>(`/v1/nodes/${enc(record!)}/history`),
  });
  // Versions that can be read: live ones up to the one this window has (a tombstone has no text).
  const versions = (history.data?.data.versions ?? []).filter((v) => v.status === 'active' && snap.version !== null && v.version <= snap.version);
  const older = versions.filter((v) => v.version !== snap.version).sort((a, b) => b.version - a.version);
  const row = view === null ? undefined : versions.find((v) => v.version === view);
  const past = useQuery({
    queryKey: ['loupe', 'doc', 'version', record, view], enabled: !!record && !!row, staleTime: Infinity,
    // A version's text is the record as the KB knew it when that version was recorded (`as_of_observed`, design 5.3 / contract 2.9).
    queryFn: () => kbFetch<{ data: NodeDetail }>(`/v1/nodes/${enc(record!)}?as_of_observed=${enc(row!.recorded_at)}&include=body`),
  });
  // The tab of a version that is gone (a revert changed the list) falls back to the current one.
  useEffect(() => { if (view !== null && history.isSuccess && !row) setView(null); }, [view, history.isSuccess, row]);

  const pastBody = past.data ? past.data.data.body ?? '' : undefined;
  const revert = () => {
    if (pastBody === undefined || snap.dirty) return;
    saver.replace(pastBody);
    setView(null);
    void saver.save();
  };
  const onArchive = async () => {
    if (!record || snap.version === null || busy) return;
    setBusy(true); setProblem(null);
    const r = await archive(record, snap.version);
    setBusy(false);
    if (!r.ok) { setProblem(r.code === 'version_conflict' ? '다른 곳에서 바뀌었다. 저장 상태를 확인한 뒤 다시 보관한다' : `보관하지 못했다 · ${r.code}`); return; }
    void qc.invalidateQueries({ queryKey: ['loupe', 'trash'] });
    onClose();
  };

  const tabs = <>
    {versions.length >= 2 && <div role="tablist" aria-label="판" className="doc-tabs" data-testid="version-tabs">
      <button type="button" role="tab" aria-selected={view === null} data-testid="version-tab" data-version="current" onClick={() => setView(null)}>현재 v{snap.version}</button>
      {older.map((v) => <button key={v.version} type="button" role="tab" aria-selected={view === v.version} data-testid="version-tab" data-version={v.version} onClick={() => setView(v.version)}>v{v.version}</button>)}
    </div>}
    {problem && <section className="memo-band" data-tone="error" data-testid="doc-problem" role="alert">{problem}</section>}
  </>;
  const viewing = view === null ? null : <div className="doc-version" data-testid="version-readonly">
    <div className="doc-version-bar">
      <span>v{view} · 읽기 전용</span>
      <button type="button" data-testid="version-revert" disabled={pastBody === undefined || snap.dirty} title={snap.dirty ? '저장하지 않은 글이 있다' : undefined} onClick={revert}>이 판으로 되돌리기</button>
    </div>
    {pastBody !== undefined
      ? <MarkdownEditor key={`v${view}`} markdown={pastBody} label={`v${view}`} editable={false} doc hideSource />
      : <p role="status">{past.isError ? '이 판을 읽지 못했다' : '판을 읽는 중'}</p>}
  </div>;
  const head = <>
    {snap.version !== null && <span className="doc-version-badge" data-testid="doc-version">v{snap.version}</span>}
    <button type="button" className="doc-archive" data-testid="doc-archive" disabled={!record || snap.version === null || snap.dirty || busy} title={snap.dirty ? '저장하지 않은 글이 있다' : '휴지통으로 보낸다'}
      onMouseDown={(e) => e.preventDefault()} onClick={() => void onArchive()}>보관</button>
  </>;
  // The database views of the document keep their filter and their save machines under this window (src/db/store.ts).
  return <DbScope.Provider value={id}><MemoWindow id={id} kind="Page" focus={!existing} onClose={onClose} onOpenSettings={onOpenSettings} slots={{ head, tabs, viewing }} /></DbScope.Provider>;
}
