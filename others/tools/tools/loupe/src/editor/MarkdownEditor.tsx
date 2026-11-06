// The Tiptap editor (design v2 4.2 decision D2, 4.5 safety). Loaded with React.lazy by EditorWindow only: nothing here is in the first-screen bundle.
// Untrusted text (a foreign body, a paste) reaches the DOM through ProseMirror's schema, whose nodes render text children only.
import { useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { ClaimBlock, EditorEnvContext, SuggestMenus, ViewBlock } from './DocParts.tsx';
import { createMarkdownCodec } from './index.ts';
import { maskExtension, maskKey } from './mask.ts';
import { hasImage, plainTextSlice, sanitizePastedHtml } from './safety.ts';
import { suggestExtension, type SuggestHandlers, type Trigger } from './suggest.ts';
import './editor.css';

/** The `[[id]]` chip. The value is a text child, never markup; the Markdown spelling is kept in the node and serialized as written.
 *  In a document (EditorEnv.openLink) a click follows the link in a window of its own (design v2 2.7 "링크가 창을 연다"). */
function WikiChip({ node }: NodeViewProps) {
  const env = useContext(EditorEnvContext);
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : null;
  const open = id && env.openLink ? () => env.openLink?.(id) : undefined;
  return <NodeViewWrapper as="span" className="wiki-link" data-wiki-id={id ?? undefined} data-valid={id ? 'true' : 'false'} title={id ? undefined : '링크 아님'}
    {...(open ? { role: 'link', 'data-testid': 'wiki-chip', onClick: open } : {})}>
    {String(node.attrs.value ?? '')}
  </NodeViewWrapper>;
}

export const SIZE_NOTE_BYTES = 48 * 1024;
export const SIZE_BLOCK_BYTES = 64 * 1024;
/** The KB refuses a body over 1 MiB (413, ADR-0005 4.5): the editor says so and the save stays shut (design v2 4.4). */
export const SIZE_MAX_BYTES = 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).length;
export const sizeLevel = (n: number): 'ok' | 'note' | 'block' | 'max' => (n >= SIZE_MAX_BYTES ? 'max' : n >= SIZE_BLOCK_BYTES ? 'block' : n >= SIZE_NOTE_BYTES ? 'note' : 'ok');

/** What a window that owns the save needs from the editor: the text as of now (the debounced `onChange` may be behind) and the focus. */
export type EditorHandle = { markdown: () => string; focus: () => void };
type Props = {
  markdown: string; label: string;
  /** The text after an edit, 120 ms after the last one. */
  onChange?: (markdown: string) => void;
  /** An edit happened (no text): the window can say "저장 안 됨" at once. */
  onEdit?: () => void;
  handleRef?: Ref<EditorHandle>;
  /** Pieces of text to paint as a bar (a secret check's matches). Keep the array stable between renders. */
  mask?: readonly string[];
  /** Without the "원문 Markdown" block, which would be a second copy of the text in the DOM. */
  hideSource?: boolean;
  autoFocus?: boolean;
  /** A document (design v2 M2): the "/" block list, the "[[" picker, the quoted claim block, links that open windows. */
  doc?: boolean;
  /** False shows a version of the record that cannot be changed: no handle, no menus, no typing. */
  editable?: boolean;
  /** How a link of the document is followed. */
  onOpenLink?: (id: string) => void;
};

export function MarkdownEditor({ markdown, label, onChange, onEdit, handleRef, mask, hideSource, autoFocus, doc = false, editable = true, onOpenLink }: Props) {
  const codec = useMemo(() => createMarkdownCodec({ doc }), [doc]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const handlers = useRef<SuggestHandlers>({ change: () => undefined, key: () => false });
  handlers.current.change = setTrigger;
  const extensions = useMemo(() => [...codec.extensions.map(extension => extension.name === 'wikiLink'
    ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(WikiChip, { as: 'span' }) })
    : extension.name === 'claimQuote' ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(ClaimBlock, { as: 'div' }) })
      : extension.name === 'loupeView' ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(ViewBlock, { as: 'div' }) }) : extension),
  maskExtension, ...(doc && editable ? [suggestExtension(handlers)] : [])], [codec, doc, editable]);
  const env = useMemo(() => ({ openLink: onOpenLink, readOnly: !editable }), [onOpenLink, editable]);
  const initial = useMemo(() => codec.parse(markdown), [codec, markdown]);
  // 4.1 item 2: an untouched document is not re-serialized. The source stays the body as read until a transaction changes the document.
  const [source, setSource] = useState(markdown);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest callbacks, so a timer set before a re-render calls the current ones.
  const callbacks = useRef({ onChange, onEdit });
  callbacks.current = { onChange, onEdit };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (changeTimer.current) clearTimeout(changeTimer.current); }, []);
  const refuseAttachment = () => setNotice('KB는 첨부를 저장하지 않는다');

  const editor = useEditor({
    extensions, content: initial, editable, immediatelyRender: true, injectCSS: false, autofocus: autoFocus && editable ? 'end' : false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': `${label} 본문 편집`, spellcheck: 'false', 'data-testid': 'editor-content' },
      transformPastedHTML: html => { if (hasImage(html)) refuseAttachment(); return sanitizePastedHtml(html); },
      clipboardTextParser: (text, _context, _plain, view) => plainTextSlice(view.state.schema, codec, text),
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        if (data && data.files.length > 0 && !data.getData('text/plain') && !data.getData('text/html')) { refuseAttachment(); return true; }
        return false;
      },
      handleDrop: (_view, event) => {
        if (event.dataTransfer && event.dataTransfer.files.length > 0) { event.preventDefault(); refuseAttachment(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      callbacks.current.onEdit?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSource(codec.serialize(e.getJSON())), 200);
      if (changeTimer.current) clearTimeout(changeTimer.current);
      if (callbacks.current.onChange) changeTimer.current = setTimeout(() => callbacks.current.onChange?.(codec.serialize(e.getJSON())), 120);
    },
  });
  useImperativeHandle(handleRef, () => ({
    markdown: () => (editor ? codec.serialize(editor.getJSON()) : markdown),
    focus: () => { editor?.commands.focus('end'); },
  }), [editor, codec, markdown]);
  useEffect(() => { if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(maskKey, mask ?? [])); }, [editor, mask]);

  const size = bytes(source);
  const level = sizeLevel(size);
  return <EditorEnvContext.Provider value={env}><div className="loupe-editor" data-testid="editor" data-readonly={editable ? undefined : 'true'}>
    <div className="loupe-editor-body">
      {editor && editable && <DragHandle editor={editor} className="loupe-drag-handle">
        <span role="img" aria-label="블록 끌기 손잡이" data-testid="editor-drag-handle">⋮⋮</span>
      </DragHandle>}
      <EditorContent editor={editor} />
      {editor && doc && editable && <SuggestMenus editor={editor} trigger={trigger} handlers={handlers} />}
    </div>
    <div className="loupe-editor-bar">
      <span className="loupe-editor-size" data-testid="editor-size" data-bytes={size} data-level={level}>{(size / 1024).toFixed(1)} KB</span>
      {level === 'note' && <span className="loupe-editor-warn" role="status">본문이 커지고 있다</span>}
      {(level === 'block' || level === 'max') && <span className="loupe-editor-warn" role="status">이 크기를 넘으면 당분간 loupe에서 다시 열 수 없다. 나눠 쓰기를 권한다</span>}
      {level === 'max' && <span className="loupe-editor-warn" data-tone="stop" role="status">1 MiB를 넘어 저장할 수 없다</span>}
      {notice && <span className="loupe-editor-warn" role="status" data-testid="editor-notice">{notice}</span>}
    </div>
    {!hideSource && <details className="loupe-editor-source">
      <summary>원문 Markdown</summary>
      <pre data-testid="editor-source" dir="auto">{source}</pre>
    </details>}
  </div></EditorEnvContext.Provider>;
}
