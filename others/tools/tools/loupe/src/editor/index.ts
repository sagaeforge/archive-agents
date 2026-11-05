import { getSchema, type JSONContent } from '@tiptap/core';
import { tiptapExtensions } from './tiptap-extensions.js';
import { MarkdownManager } from '@tiptap/markdown';

/** Use the same extensions for the editor UI and the headless persistence path. */
export function createMarkdownCodec() {
  const extensions = tiptapExtensions();
  const manager = new MarkdownManager({ extensions, marked: extensions.find(extension => extension.name === 'markdown')!.options.marked });
  const schema = getSchema(extensions);
  return {
    extensions,
    parse(markdown: string): JSONContent {
      const json = manager.parse(markdown);
      const doc = json.content?.length ? schema.nodeFromJSON(json) : schema.topNodeType.createAndFill();
      if (!doc) throw new Error('Cannot create an empty Markdown document');
      doc.check();
      return doc.toJSON() as JSONContent;
    },
    serialize(doc: JSONContent): string {
      schema.nodeFromJSON(doc).check();
      return manager.serialize(doc);
    },
  };
}

/** Match the reader: code and existing hyperlinks do not produce wiki links. */
export function editorWikiIds(doc: JSONContent): string[] {
  const ids: string[] = [];
  function collect(node: JSONContent) {
    if (node.type === 'wikiLink' && node.attrs?.id && !node.marks?.some(mark => mark.type === 'link')) ids.push(String(node.attrs.id));
    node.content?.forEach(collect);
  }
  collect(doc);
  return ids;
}
