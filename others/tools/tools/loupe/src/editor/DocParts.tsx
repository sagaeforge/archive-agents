// The parts of a document editor that draw (design v2 4.2, 4.4, 4.5): the quoted claim block, and the menus of the "/" and "[[" triggers (suggest.ts).
// Every value comes to the screen as a text child of a React element. Nothing here sets innerHTML.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { NodeViewWrapper, type Editor, type NodeViewProps } from '@tiptap/react';
import type { SearchHit, Snapshot } from '../client/model/index.ts';
import kbFetch from '../data/kbFetch.ts';
import { useClaim } from '../data/hooks.ts';
import { dismissSuggest, filterSlash, type SlashId, type SlashItem, type SuggestHandlers, type Trigger } from './suggest.ts';
import { parseKbId } from '../ids.ts';
import { DbView } from '../db/DbView.tsx';
import { viewSource } from '../db/view.ts';

/** What the editor's surroundings give its parts: how a link is followed (a window of the workspace), and nothing else. */
export type EditorEnv = { openLink?: ((id: string) => void) | undefined; /** A version that cannot be changed: a database block then reads nothing and edits nothing. */ readOnly?: boolean | undefined };
export const EditorEnvContext = createContext<EditorEnv>({});

// ---- the quoted claim (design 4.4: `[[c-…]]` on a line of its own)
export function ClaimBlock({ node, selected }: NodeViewProps) {
  const env = useContext(EditorEnvContext);
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : '';
  const claim = useClaim(id);
  const c = claim.data?.data;
  const snapshotId = c?.evidence?.[0]?.snapshot_id;
  const snapshot = useQuery({
    queryKey: ['loupe', 'doc', 'snapshot', snapshotId], enabled: !!snapshotId, staleTime: 60_000,
    queryFn: () => kbFetch<{ data: Snapshot }>(`/v1/snapshots/${encodeURIComponent(snapshotId!)}`),
  }).data?.data;
  return <NodeViewWrapper as="div" className="claim-quote" contentEditable={false} data-testid="claim-quote" data-claim-id={id} data-selected={selected || undefined} role="figure" aria-label="주장 인용">
    {claim.isError ? <p className="claim-quote-missing" role="status">주장을 찾을 수 없다</p>
      : !c ? <p className="claim-quote-missing" role="status">주장을 읽는 중</p>
        : <blockquote dir="auto">{c.statement}</blockquote>}
    <p className="claim-quote-source" data-testid="claim-quote-source">
      <span>출처: </span>
      {snapshot ? <><bdi>{snapshot.source.label}</bdi><span> · </span><bdi>{snapshot.url}</bdi></> : <span>{snapshotId ? '읽는 중' : c ? '근거 없음' : ''}</span>}
      <span className="claim-quote-id"> · {id}</span>
      {/* Not a button: the editor's DOM holds no form controls (design 4.5, e2e/v2-editor.spec.ts FORBIDDEN). */}
      {env.openLink && <span role="link" tabIndex={0} className="claim-quote-open" data-testid="claim-quote-open" onMouseDown={(e) => e.preventDefault()} onClick={() => env.openLink?.(id)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.stopPropagation(); env.openLink?.(id); } }}>열기</span>}
    </p>
  </NodeViewWrapper>;
}

// ---- the database view (design 4.3: a ```loupe-view block). The table is src/db/DbView.tsx; this is only the block it sits in. Its cells are form fields, so the editor's
// own events stop at them (Tiptap's node view does that for input, select, button), and the block's text is the definition, which the table never writes back.
export function ViewBlock({ node, selected }: NodeViewProps) {
  const env = useContext(EditorEnvContext);
  return <NodeViewWrapper as="div" className="loupe-view-block" contentEditable={false} data-testid="db-block" data-selected={selected || undefined}>
    <DbView source={typeof node.attrs.source === 'string' ? node.attrs.source : ''} readOnly={env.readOnly === true} />
  </NodeViewWrapper>;
}

// ---- the menus
type Pick = { id: string; title: string; type: string; kind: string; source: string | null };
const KINDS_ALL = 'entity,record,claim';
const hitOf = (h: SearchHit): Pick => ({ id: h.id, title: h.title ?? h.id, type: h.type ?? '', kind: String(h.kind ?? ''), source: (h as { source?: { label?: string } }).source?.label ?? null });

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** The same search as the find window (design 4.4 "찾기와 같은 검색"): titles of entities and records, and the sentences of claims. */
function usePick(query: string, kinds: string) {
  const q = useDebounced(query.normalize('NFC').trim(), 150);
  const search = useQuery({
    queryKey: ['loupe', 'doc', 'pick', kinds, q], enabled: q.length > 0, staleTime: 30_000, placeholderData: keepPreviousData,
    queryFn: () => kbFetch<{ data: { items: SearchHit[] } }>(`/v1/search?q=${encodeURIComponent(q)}&kinds=${kinds}&limit=8`),
  });
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (q ? search.data?.data.items ?? [] : []).map(hitOf).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [search.data, q]);
  return { items, waiting: query.trim().length > 0 && (q !== query.normalize('NFC').trim() || search.isFetching), failed: search.isError };
}

// The block commands come from the extensions the editor was built with; their typings only exist where those extension packages are imported.
type Chain = Record<string, (arg?: unknown) => { run: () => boolean }>;
const TOGGLE: Partial<Record<SlashId, (e: Editor) => boolean>> = {
  heading1: (e) => (e.chain() as unknown as Chain).toggleHeading!({ level: 1 }).run(),
  heading2: (e) => (e.chain() as unknown as Chain).toggleHeading!({ level: 2 }).run(),
  heading3: (e) => (e.chain() as unknown as Chain).toggleHeading!({ level: 3 }).run(),
  bullet: (e) => (e.chain() as unknown as Chain).toggleBulletList!().run(),
  ordered: (e) => (e.chain() as unknown as Chain).toggleOrderedList!().run(),
  task: (e) => (e.chain() as unknown as Chain).toggleTaskList!().run(),
  quote: (e) => (e.chain() as unknown as Chain).toggleBlockquote!().run(),
  code: (e) => (e.chain() as unknown as Chain).toggleCodeBlock!().run(),
  rule: (e) => (e.chain() as unknown as Chain).setHorizontalRule!().run(),
};

function Menu({ trigger, label, children }: { trigger: Trigger; label: string; children: ReactNode }) {
  return createPortal(
    <div className="suggest" role="listbox" aria-label={label} data-testid="suggest-menu" style={{ left: Math.max(8, Math.min(trigger.at.left, innerWidth - 320)), top: trigger.at.bottom + 4 }}>{children}</div>,
    document.body);
}

/** The open trigger's menu. It owns the key handling while it is open (`handlers.current.key`). */
export function SuggestMenus({ editor, trigger, handlers }: { editor: Editor; trigger: Trigger | null; handlers: RefObject<SuggestHandlers> }) {
  const [claimOnly, setClaimOnly] = useState(false);
  const [index, setIndex] = useState(0);
  const query = trigger?.query ?? '';
  const slash = trigger?.kind === 'slash' ? filterSlash(query) : [];
  const pick = usePick(trigger?.kind === 'link' ? query : '', claimOnly ? 'claim' : KINDS_ALL);
  const count = trigger?.kind === 'slash' ? slash.length : pick.items.length;
  useEffect(() => { setIndex(0); }, [trigger?.kind, trigger?.from, query, count]);
  useEffect(() => { if (!trigger) setClaimOnly(false); }, [trigger]);
  const active = Math.min(index, Math.max(0, count - 1));

  const chooseSlash = (item: SlashItem) => {
    if (!trigger) return;
    const range = { from: trigger.from, to: trigger.to };
    if (item.id === 'claim') {
      // The picker opens in the same place, for claims only.
      setClaimOnly(true);
      editor.chain().focus().deleteRange(range).insertContent('[[').run();
      return;
    }
    if (item.id === 'database') {
      // A view block of memos, on a line of its own; a block after it when it is the last, so the cursor has somewhere to go.
      editor.chain().focus().deleteRange(range).run();
      const { $from } = editor.state.selection;
      const view = { type: 'loupeView', attrs: { source: viewSource('Note'), fence: '```', info: '' } };
      const onItsOwn = $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth === 1;
      if (onItsOwn) {
        const last = $from.after() >= editor.state.doc.content.size;
        editor.chain().focus().insertContentAt({ from: $from.before(), to: $from.after() }, [view, ...(last ? [{ type: 'paragraph' }] : [])]).run();
      } else editor.chain().focus().insertContent(view).run();
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    TOGGLE[item.id]?.(editor);
    editor.commands.focus();
  };
  const choosePick = (p: Pick) => {
    if (!trigger) return;
    // The same rule as the `[[…]]` reader: a public id, and no `]` that would end the link early.
    const parsed = parseKbId(p.id);
    if (!parsed.ok || p.id.includes(']')) return;
    const id = parsed.id;
    const range = { from: trigger.from, to: trigger.to };
    editor.chain().focus().deleteRange(range).run();
    const { $from } = editor.state.selection;
    const onItsOwn = p.kind === 'claim' && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth === 1;
    if (onItsOwn && editor.schema.nodes.claimQuote) {
      const last = $from.after() >= editor.state.doc.content.size;
      editor.chain().focus().insertContentAt({ from: $from.before(), to: $from.after() }, [{ type: 'claimQuote', attrs: { id } }, ...(last ? [{ type: 'paragraph' }] : [])]).run();
      return;
    }
    editor.chain().focus().insertContent({ type: 'wikiLink', attrs: { source: `[[${id}]]`, id, value: id } }).run();
  };

  useLayoutEffect(() => {
    handlers.current.key = (e) => {
      if (!trigger) return false;
      if (e.key === 'Escape') {
        if (trigger.kind === 'link') editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.from + 2 }).run();
        else dismissSuggest(editor.view);
        return true;
      }
      if (count === 0) return false;
      if (e.key === 'ArrowDown') { setIndex((active + 1) % count); return true; }
      if (e.key === 'ArrowUp') { setIndex((active + count - 1) % count); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (trigger.kind === 'slash') chooseSlash(slash[active]!); else choosePick(pick.items[active]!);
        return true;
      }
      return false;
    };
  });
  useEffect(() => {
    // Only while a menu is open, which a mounted view said (the view is not available before the editor is on screen).
    if (!trigger || count === 0) return;
    const dom = editor.view.dom;
    dom.setAttribute('aria-activedescendant', `suggest-option-${active}`);
    return () => dom.removeAttribute('aria-activedescendant');
  }, [editor, trigger, count, active]);

  if (!trigger) return null;
  if (trigger.kind === 'slash') {
    if (slash.length === 0) return null;
    return <Menu trigger={trigger} label="블록 넣기">
      {slash.map((item, i) => <div key={item.id} id={`suggest-option-${i}`} role="option" aria-selected={i === active} className="suggest-option" data-testid="slash-option" data-command={item.id}
        onMouseDown={(e) => e.preventDefault()} onClick={() => chooseSlash(item)}>
        <strong>{item.label}</strong><small>{item.hint}</small>
      </div>)}
    </Menu>;
  }
  return <Menu trigger={trigger} label="링크 고르기">
    {pick.items.map((p, i) => <div key={p.id} id={`suggest-option-${i}`} role="option" aria-selected={i === active} className="suggest-option" data-testid="pick-option" data-id={p.id} data-kind={p.kind}
      onMouseDown={(e) => e.preventDefault()} onClick={() => choosePick(p)}>
      <bdi className="suggest-title">{p.title}</bdi><small>{p.kind === 'claim' ? `주장${p.source ? ` · ${p.source}` : ''}` : p.type}</small>
    </div>)}
    <div className="suggest-hint" role="status">
      {claimOnly && !query.trim() ? '주장 문장의 일부를 입력한다' : !query.trim() ? '링크할 이름을 입력한다' : pick.failed ? '찾지 못했다' : pick.waiting ? '찾는 중' : pick.items.length === 0 ? '일치하는 항목이 없다' : ''} · Esc로 닫기
    </div>
  </Menu>;
}
