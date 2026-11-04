import { Editor } from '@tiptap/core';
import { tiptapExtensions } from './tiptap-extensions.js';
import { mount } from './ui.jsx';

mount('tiptap', async (host, markdown) => {
  const editor = new Editor({
    element: host,
    extensions: tiptapExtensions(),
    content: markdown, contentType: 'markdown',
  });
  return { view: editor.view, serialize: () => editor.getMarkdown(), destroy: () => editor.destroy() };
});
