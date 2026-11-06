// The body of an editor window, rendered inside WindowReadView's WindowTitleScope (so PageRoot is a div, not a second <main>). Default export so that WindowReadView can load it with React.lazy: this file and everything it pulls in
// (Tiptap, ProseMirror, marked) form the editor chunk, which the first screen never fetches.
import { PageRoot } from '../components/PageRoot.tsx';
import { Loading } from '../components/bits.tsx';
import { useNodeDetail } from '../data/hooks.ts';
import { MarkdownEditor } from './MarkdownEditor.tsx';

export default function EditorWindow({ id }: { id: string }) {
  const q = useNodeDetail(id, {});
  const node = q.data?.data;
  if (q.isError) return <PageRoot className="page window-entity"><p role="alert">본문을 읽지 못했다</p></PageRoot>;
  if (!node) return <PageRoot className="page window-entity"><Loading /></PageRoot>;
  const body = node.body ?? '';
  // A body read in parts must not be opened as if it were whole: the rest would be lost on a later save.
  if ((node.body_chars ?? body.length) > body.length) return <PageRoot className="page window-entity" data-testid="editor-partial"><p role="status">본문이 길어 여기서는 편집하지 않는다</p></PageRoot>;
  return <PageRoot className="window-editor" data-testid="editor-page" data-id={id}><MarkdownEditor key={id} markdown={body} label={node.label} /></PageRoot>;
}
