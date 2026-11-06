import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { offlineGfm } from './tiptap-gfm.js';
import { markdownSyntax, markdownEngine } from './tiptap-markdown.js';
import { blockMove, claimQuote, loupeView } from './tiptap-doc.js';

/** `doc: true` adds what a document has beyond a memo: the quoted claim block, the database view block and the block-move keys (tiptap-doc.js). */
export function tiptapExtensions({ doc = false } = {}) {
  return [StarterKit.configure({ underline: false, trailingNode: false,
    document: false, bold: false, italic: false, strike: false,
    codeBlock: false, bulletList: false, listItem: false, link: false, hardBreak: false }),
    Markdown.configure({ marked: markdownEngine() }), ...markdownSyntax, ...offlineGfm, ...(doc ? [claimQuote, loupeView, blockMove] : [])];
}
