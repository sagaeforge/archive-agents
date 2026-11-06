// The two triggers of a document (design v2 4.2 "Notion식 조작", 4.4 "링크와 본문 규칙"): "/" opens the block list, "[[" opens the link picker.
// @tiptap/suggestion is not installed, so this is the small plugin both need: it reads the text before the cursor, tells the view which trigger is
// open and where, and hands the keys to the menu while one is. Nothing here draws; MarkdownEditor's menus do.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export type TriggerKind = 'slash' | 'link';
export type Found = { kind: TriggerKind; query: string; /** Characters of the trigger and the query, in the text before the cursor. */ length: number };
export type Trigger = Found & { from: number; to: number; /** Viewport rectangle of the cursor. */ at: { left: number; top: number; bottom: number } };

// `[[` and what follows it up to the cursor, with no bracket or line break in it. A finished `[[id]]` before it does not count.
const LINK = /\[\[([^[\]\n]*)$/;
// "/" at the start of the block or after a space, then a query that does not begin with a space. "and/or" and "a / b" are text.
const SLASH = /(?:^|\s)\/((?:[^\s/][^/\n]{0,23})?)$/;

export function findTrigger(before: string): Found | null {
  const link = LINK.exec(before);
  if (link) return { kind: 'link', query: link[1]!, length: link[0].length };
  const slash = SLASH.exec(before);
  if (slash) return { kind: 'slash', query: slash[1]!, length: slash[1]!.length + 1 };
  return null;
}

// ---- the block list
export type SlashId = 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'rule' | 'claim' | 'database';
export type SlashItem = { id: SlashId; label: string; hint: string; keywords: readonly string[] };
export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'heading1', label: '제목 1', hint: '큰 제목', keywords: ['h1', 'heading', 'title', '제목'] },
  { id: 'heading2', label: '제목 2', hint: '중간 제목', keywords: ['h2', 'heading', '제목'] },
  { id: 'heading3', label: '제목 3', hint: '작은 제목', keywords: ['h3', 'heading', '제목'] },
  { id: 'bullet', label: '글머리 목록', hint: '- 항목', keywords: ['ul', 'list', 'bullet', '목록'] },
  { id: 'ordered', label: '번호 목록', hint: '1. 항목', keywords: ['ol', 'list', 'number', '목록'] },
  { id: 'task', label: '할 일', hint: '- [ ] 항목', keywords: ['todo', 'task', 'check', '체크'] },
  { id: 'quote', label: '인용', hint: '> 인용문', keywords: ['quote', 'blockquote'] },
  { id: 'code', label: '코드 블록', hint: '``` 코드', keywords: ['code', 'pre', '코드'] },
  { id: 'rule', label: '구분선', hint: '---', keywords: ['hr', 'divider', 'rule', 'line'] },
  { id: 'claim', label: '주장 인용', hint: '[[c-…]] KB의 주장과 출처', keywords: ['claim', 'cite', '출처'] },
  { id: 'database', label: '데이터베이스', hint: '```loupe-view 메모·문서를 표로', keywords: ['db', 'database', 'table', 'view', '표', '보기'] },
];
const fold = (s: string) => s.normalize('NFC').toLowerCase();
export function filterSlash(query: string): SlashItem[] {
  const q = fold(query.trim());
  if (!q) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter((i) => fold(i.label).includes(q) || i.keywords.some((k) => fold(k).includes(q)));
}

// ---- the plugin
export type SuggestHandlers = {
  /** The open trigger changed (or closed: null). */
  change: (t: Trigger | null) => void;
  /** A key while a trigger is open. True means the menu took it. */
  key: (e: KeyboardEvent) => boolean;
};
const key = new PluginKey<{ dismissed: string | null }>('loupe-suggest');

function read(state: EditorState): { found: Found; from: number; to: number } | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $from = sel.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const found = findTrigger(before);
  return found ? { found, from: $from.pos - found.length, to: $from.pos } : null;
}

/** Closes the open trigger until the person types a new one (the text of this one stays as it is). */
export function dismissSuggest(view: EditorView) {
  const open = read(view.state);
  if (open) view.dispatch(view.state.tr.setMeta(key, { dismiss: `${open.found.kind}:${open.from}` }));
}

export const suggestExtension = (handlers: { current: SuggestHandlers }) => Extension.create({
  name: 'loupeSuggest',
  addProseMirrorPlugins: () => [new Plugin<{ dismissed: string | null }>({
    key,
    state: {
      init: () => ({ dismissed: null }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(key) as { dismiss?: string } | undefined;
        if (meta?.dismiss) return { dismissed: meta.dismiss };
        // Once no trigger is open any more, the next one is a new one even at the same place.
        return prev.dismissed && !read(state) ? { dismissed: null } : prev;
      },
    },
    view: () => {
      let last = '';
      return {
        update(view) {
          const open = read(view.state);
          const id = open ? `${open.found.kind}:${open.from}` : null;
          const dismissed = key.getState(view.state)?.dismissed ?? null;
          if (!open || id === dismissed) {
            if (last) { last = ''; handlers.current.change(null); }
            return;
          }
          const c = view.coordsAtPos(open.to);
          const sig = `${id}|${open.found.query}|${Math.round(c.left)}|${Math.round(c.bottom)}`;
          if (sig === last) return;
          last = sig;
          handlers.current.change({ ...open.found, from: open.from, to: open.to, at: { left: c.left, top: c.top, bottom: c.bottom } });
        },
        destroy() { handlers.current.change(null); },
      };
    },
    props: {
      // IME: a key that belongs to the composition is not the menu's (the same rule as the window's keys, wm/model.ts isComposing).
      handleKeyDown: (view, event) => {
        if (event.isComposing || event.keyCode === 229) return false;
        const open = read(view.state);
        if (!open || `${open.found.kind}:${open.from}` === key.getState(view.state)?.dismissed) return false;
        return handlers.current.key(event);
      },
    },
  })],
});
