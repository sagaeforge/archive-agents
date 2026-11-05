// The Tiptap editor (design v2 4.2 decision D2, 4.5 safety). Loaded with React.lazy by EditorWindow only: nothing here is in the first-screen bundle.
// Untrusted text (a foreign body, a paste) reaches the DOM through ProseMirror's schema, whose nodes render text children only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { createMarkdownCodec } from './index.ts';
import { hasImage, plainTextSlice, sanitizePastedHtml } from './safety.ts';
import './editor.css';

/** The `[[id]]` chip. The value is a text child, never markup; the Markdown spelling is kept in the node and serialized as written. */
function WikiChip({ node }: NodeViewProps) {
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : null;
  return <NodeViewWrapper as="span" className="wiki-link" data-wiki-id={id ?? undefined} data-valid={id ? 'true' : 'false'} title={id ? undefined : '링크 아님'}>
    {String(node.attrs.value ?? '')}
  </NodeViewWrapper>;
}

export const SIZE_NOTE_BYTES = 48 * 1024;
export const SIZE_BLOCK_BYTES = 64 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).length;

type Props = { markdown: string; label: string };

export function MarkdownEditor({ markdown, label }: Props) {
  const codec = useMemo(() => createMarkdownCodec(), []);
  const extensions = useMemo(() => codec.extensions.map(extension => extension.name === 'wikiLink'
    ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(WikiChip, { as: 'span' }) }) : extension), [codec]);
  const initial = useMemo(() => codec.parse(markdown), [codec, markdown]);
  // 4.1 item 2: an untouched document is not re-serialized. The source stays the body as read until a transaction changes the document.
  const [source, setSource] = useState(markdown);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const refuseAttachment = () => setNotice('KB는 첨부를 저장하지 않는다');

  const editor = useEditor({
    extensions, content: initial, immediatelyRender: true, injectCSS: false,
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
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSource(codec.serialize(e.getJSON())), 200);
    },
  });

  const size = bytes(source);
  return <div className="loupe-editor" data-testid="editor">
    <div className="loupe-editor-body">
      {editor && <DragHandle editor={editor} className="loupe-drag-handle">
        <span role="img" aria-label="블록 끌기 손잡이" data-testid="editor-drag-handle">⋮⋮</span>
      </DragHandle>}
      <EditorContent editor={editor} />
    </div>
    <div className="loupe-editor-bar">
      <span data-testid="editor-size" data-bytes={size}>{(size / 1024).toFixed(1)} KB</span>
      {size >= SIZE_NOTE_BYTES && size < SIZE_BLOCK_BYTES && <span className="loupe-editor-warn" role="status">본문이 커지고 있다</span>}
      {size >= SIZE_BLOCK_BYTES && <span className="loupe-editor-warn" role="status">이 크기를 넘으면 당분간 loupe에서 다시 열 수 없다. 나눠 쓰기를 권한다</span>}
      {notice && <span className="loupe-editor-warn" role="status" data-testid="editor-notice">{notice}</span>}
    </div>
    <details className="loupe-editor-source">
      <summary>원문 Markdown</summary>
      <pre data-testid="editor-source" dir="auto">{source}</pre>
    </details>
  </div>;
}
