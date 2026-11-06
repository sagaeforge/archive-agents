import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { removePosition } from 'unist-util-remove-position';
// Read only: run the actual loupe reader, rather than a copied wiki regexp.
import { markdownToTree, linkNodeRefs } from '../../../../../tools/loupe/src/render/pipeline.ts';
import { NODE_HREF } from '../../../../../tools/loupe/src/render/nodeHref.ts';

const parser = unified().use(remarkParse).use(remarkGfm);
export const ast = text => {
  const tree = parser.parse(text);
  removePosition(tree, { force: true });
  return JSON.stringify(tree);
};
export function codeBlocks(text) {
  const blocks = [];
  function visit(node) {
    if (node.type === 'code') blocks.push({ language: node.lang ?? null, meta: node.meta ?? null, value: node.value });
    for (const child of node.children ?? []) visit(child);
  }
  visit(parser.parse(text));
  return blocks;
}
export async function readerIds(text) {
  const tree = linkNodeRefs(await markdownToTree(text));
  const ids = [];
  function visit(node) {
    if (node.type === 'element' && node.tagName === 'a' && node.properties?.href?.startsWith(NODE_HREF)) ids.push(node.properties.href.slice(NODE_HREF.length));
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return ids;
}
export function editorWikiIds(doc) {
  const ids = [];
  function visit(node) {
    if (node.type === 'wikiLink' && node.attrs?.id && !node.marks?.some(mark => mark.type === 'link')) ids.push(node.attrs.id);
    for (const child of node.content ?? []) visit(child);
  }
  visit(doc);
  return ids;
}
