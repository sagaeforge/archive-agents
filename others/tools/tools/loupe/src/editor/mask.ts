// Paints given pieces of text as a black bar (design v2 5.5, 5.7: "구간만 칠한다"). The pieces are the spans a secret check matched; they are held
// by this plugin in memory and drawn as a decoration class, so the editor's own document is the only place the text is. Nothing is added to the DOM
// beyond the class on the existing text. CSS in src/memo/memo.css makes the class unreadable.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const maskKey = new PluginKey<{ needles: readonly string[]; set: DecorationSet }>('loupe-mask');

function paint(doc: PMNode, needles: readonly string[]): DecorationSet {
  if (needles.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One string per text block, with a placeholder for each non-text child, and the document position of every character in it.
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText && child.text) for (let i = 0; i < child.text.length; i++) { text += child.text[i]!; at.push(start + i); }
      else { text += '￼'; at.push(start); }
    });
    for (const needle of needles) {
      if (!needle) continue;
      for (let from = 0; ;) {
        const i = text.indexOf(needle, from);
        if (i < 0) break;
        decorations.push(Decoration.inline(at[i]!, at[i + needle.length - 1]! + 1, { class: 'memo-hit' }));
        from = i + needle.length;
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const maskExtension = Extension.create({
  name: 'loupeMask',
  addProseMirrorPlugins: () => [new Plugin<{ needles: readonly string[]; set: DecorationSet }>({
    key: maskKey,
    state: {
      init: () => ({ needles: [], set: DecorationSet.empty }),
      apply(tr, prev) {
        const meta = tr.getMeta(maskKey) as readonly string[] | undefined;
        if (meta) return { needles: meta, set: paint(tr.doc, meta) };
        return tr.docChanged && prev.needles.length ? { needles: prev.needles, set: paint(tr.doc, prev.needles) } : prev;
      },
    },
    props: { decorations: (state) => maskKey.getState(state)?.set ?? DecorationSet.empty },
  })],
});
