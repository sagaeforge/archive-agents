// What a document has beyond a memo (design v2 4.2, 4.4, 4.5), as Tiptap extensions. Only a document editor loads them (tiptap-extensions.js with
// `{ doc: true }`); the memo editor and its allow-list test stay as they were, and a `[[c-…]]` line is a link in a paragraph there.
import { Extension, Node } from '@tiptap/core';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import { safeFence } from './tiptap-markdown.js';

/** `c-` and 12 characters (ADR-0005 4.6). The KB's own ids use base32; the fixtures of kb-mock are looser, so the class here is the looser one. */
export const CLAIM_ID = /^c-[a-z0-9]{12}$/;

/**
 * The quoted claim (design 4.4 "`[[c-…]]` 단독 줄"): a block that stands for one claim of the KB and shows it with its source. Its Markdown is the
 * line `[[c-…]]` and nothing else, so a document that never opens in this editor keeps reading as it was written.
 * The block holds an id and no text. What it shows (statement, source) is read from the KB by the node view, never from the document or a paste,
 * and there is no parse rule for HTML: pasted markup cannot make one, or give one a source of its own choosing (design 4.5).
 */
export const claimQuote = Node.create({
  name: 'claimQuote', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes: () => ({ id: { default: null } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['div', { class: 'claim-quote', 'data-claim-id': node.attrs.id }, `[[${node.attrs.id}]]`],
  markdownTokenizer: {
    name: 'claimQuote', level: 'block',
    // Never interrupts a paragraph: a `[[c-…]]` line right under a text line is part of that paragraph (CommonMark), only one that begins a block is a quote.
    // (A tokenizer without `start` makes @tiptap/markdown probe it on a lexer of its own, and the paragraphs of the document lose their inline tokens.)
    start: () => -1,
    tokenize(source) {
      const match = /^\[\[(c-[a-z0-9]{12})\]\][ \t]*(?:\n|$)/.exec(source);
      return match ? { type: 'claimQuote', raw: match[0], id: match[1] } : undefined;
    },
  },
  parseMarkdown: (token, h) => h.createNode('claimQuote', { id: token.id }),
  renderMarkdown: node => `[[${node.attrs.id}]]`,
});

/**
 * The database view block (design v2 4.3, 4.5): a fenced code block whose info string is exactly `loupe-view`. Its text is the view's definition (src/db/view.ts), kept as it was
 * written and shown by a node view that draws a table of records. The block holds that text and nothing else; what the table shows comes from the KB, never from the document.
 * Only a fence at the start of a line is one (an indented fence is indented code); any other info string stays an ordinary code block. Its Markdown is the fence as it was.
 */
export const loupeView = Node.create({
  name: 'loupeView', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes: () => ({ source: { default: '', rendered: false }, fence: { default: '```', rendered: false }, info: { default: '', rendered: false } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['div', { class: 'loupe-view' }, node.attrs.source],
  markdownTokenizer: {
    name: 'loupeView', level: 'block',
    // A fence ends a paragraph by itself (CommonMark), so this never has to cut one.
    start: () => -1,
    tokenize(source) {
      const open = /^(`{3,}|~{3,})loupe-view([ \t][^\n]*)?(?:\n|$)/.exec(source);
      if (!open) return undefined;
      const fence = open[1], close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
      const lines = [];
      let at = open[0].length;
      while (at < source.length) {
        const nl = source.indexOf('\n', at), line = source.slice(at, nl === -1 ? source.length : nl);
        at = nl === -1 ? source.length : nl + 1;
        if (close.test(line)) break;
        lines.push(line);
      }
      return { type: 'loupeView', raw: source.slice(0, at), fence, info: open[2] ?? '', text: lines.join('\n') };
    },
  },
  parseMarkdown: (token, h) => h.createNode('loupeView', { source: token.text, fence: token.fence, info: token.info }),
  renderMarkdown: node => {
    const source = node.attrs.source ?? '', original = node.attrs.fence || '```', character = original[0];
    const fence = character.repeat(Math.max(original.length, safeFence(source, character).length));
    return `${fence}loupe-view${node.attrs.info ?? ''}\n${source ? `${source}\n` : ''}${fence}`;
  },
});

/** Alt+ArrowUp / Alt+ArrowDown move the top-level block under the cursor one place (design 2.7: these keys belong to the editor's block move). */
export const blockMove = Extension.create({
  name: 'loupeBlockMove',
  addKeyboardShortcuts() {
    const move = direction => ({ tr, state }) => {
      const doc = state.doc;
      const index = state.selection.$from.index(0), target = index + direction;
      if (target < 0 || target >= doc.childCount) return false;
      let at = 0;
      for (let i = 0; i < Math.min(index, target); i++) at += doc.child(i).nodeSize;
      const first = doc.child(Math.min(index, target)), second = doc.child(Math.max(index, target));
      tr.replaceWith(at, at + first.nodeSize + second.nodeSize, [second, first]);
      // The cursor goes with the block that moved.
      const start = direction < 0 ? at : at + second.nodeSize;
      const moved = doc.child(index);
      tr.setSelection(moved.isAtom ? NodeSelection.create(tr.doc, start) : Selection.near(tr.doc.resolve(start + 1)));
      return true;
    };
    return {
      'Alt-ArrowUp': ({ editor }) => editor.commands.command(move(-1)),
      'Alt-ArrowDown': ({ editor }) => editor.commands.command(move(1)),
    };
  },
});
