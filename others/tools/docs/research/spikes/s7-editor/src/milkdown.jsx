import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { mount } from './ui.jsx';

mount('milkdown', async (host, markdown) => {
  const editor = await Editor.make()
    .config(ctx => { ctx.set(rootCtx, host); ctx.set(defaultValueCtx, markdown); })
    .use(commonmark).use(gfm).use(history).use(clipboard).create();
  return {
    view: editor.ctx.get(editorViewCtx),
    serialize: () => editor.action(ctx => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)),
    destroy: () => editor.destroy(),
  };
});
