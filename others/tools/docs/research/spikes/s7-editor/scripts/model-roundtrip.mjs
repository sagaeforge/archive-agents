// Real parser/schema/serializer fallback for environments unable to launch
// Chromium. This never claims to exercise a DOM, an EditorView, or an IME.
import { Container, Clock, Ctx } from '@milkdown/ctx';
import * as core from '@milkdown/core';
import * as commonmark from '@milkdown/preset-commonmark';
import * as gfm from '@milkdown/preset-gfm';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { tiptapExtensions } from '../src/tiptap-extensions.js';

function snapshot(doc, markdown) {
  return { markdown, json: doc.toJSON(), text: doc.textBetween(0, doc.content.size, '\n', node => node.attrs.value ?? '') };
}

export async function modelLoader(name) {
  if (name === 'tiptap') {
    const extensions = tiptapExtensions();
    const manager = new MarkdownManager({ extensions,
      marked: extensions.find(extension => extension.name === 'markdown').options.marked });
    const schema = getSchema(extensions);
    return async markdown => {
      const json = manager.parse(markdown);
      const doc = json.content?.length ? schema.nodeFromJSON(json) : schema.topNodeType.createAndFill();
      doc.check();
      return snapshot(doc, manager.serialize(doc.toJSON()));
    };
  }
  // Milkdown's own public context/plugin primitives, schema and remark plugins.
  // Node EventTarget supplies only its timer events, not a browser DOM shim.
  const target = new EventTarget();
  globalThis.addEventListener ??= target.addEventListener.bind(target);
  globalThis.removeEventListener ??= target.removeEventListener.bind(target);
  globalThis.dispatchEvent ??= target.dispatchEvent.bind(target);
  const ctx = new Ctx(new Container(), new Clock());
  const plugins = [core.schema, core.parser, core.serializer, core.init(core.Editor.make()), core.config(() => {}),
    ...commonmark.schema, ...gfm.schema, commonmark.blockContainerTypes,
    ...commonmark.remarkAddOrderInListPlugin, ...commonmark.remarkInlineLinkPlugin,
    ...commonmark.remarkLineBreak, ...commonmark.remarkHtmlTransformer,
    ...commonmark.remarkMarker, ...commonmark.remarkPreserveEmptyLinePlugin,
    ...gfm.remarkGFMPlugin];
  const handlers = plugins.map(plugin => plugin(ctx));
  await Promise.all(handlers.map(handler => handler()));
  return async markdown => {
    const doc = ctx.get(core.parserCtx)(markdown);
    doc.check();
    return snapshot(doc, ctx.get(core.serializerCtx)(doc));
  };
}
