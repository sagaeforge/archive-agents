import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { offlineGfm } from './tiptap-gfm.js';
import { markdownSyntax, markdownEngine } from './tiptap-markdown.js';

export function tiptapExtensions() {
  return [StarterKit.configure({ underline: false, trailingNode: false,
    document: false, bold: false, italic: false, strike: false,
    codeBlock: false, bulletList: false, listItem: false, link: false, hardBreak: false }),
    Markdown.configure({ marked: markdownEngine() }), ...markdownSyntax, ...offlineGfm];
}
