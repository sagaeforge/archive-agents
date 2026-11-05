import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { JSONContent } from '@tiptap/core';
import { visit } from 'unist-util-visit';
import { createMarkdownCodec, editorWikiIds } from '../../src/editor/index.ts';
import { markdownToTree, linkNodeRefs } from '../../src/render/pipeline.ts';
import { NODE_HREF } from '../../src/render/nodeHref.ts';

const fixtures = new URL('../fixtures/editor/', import.meta.url);
type Sample = { id: string; markdown?: string; repeat?: string; count?: number };
const corpus = (JSON.parse(readFileSync(new URL('corpus.json', fixtures), 'utf8')) as Sample[])
  .map(s => ({ id: s.id, markdown: s.markdown ?? s.repeat!.repeat(s.count!) }));
const parser = unified().use(remarkParse).use(remarkGfm);
// Match the spike: remove positions only; retain all semantic AST fields.
const ast = (text: string) => JSON.parse(JSON.stringify(parser.parse(text), (key, value: unknown) => key === 'position' ? undefined : value)) as unknown;
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
const codec = createMarkdownCodec();
const roundtrip = (text: string) => codec.serialize(codec.parse(text));
const changes = () => corpus.filter(s => normalize(s.markdown) !== normalize(roundtrip(s.markdown)))
  .map(s => ({ id: s.id, input: s.markdown, output: roundtrip(s.markdown) }));

describe('M0a Markdown round-trip', () => {
  for (const sample of corpus) {
    it(`${sample.id}: schema-valid parse and full remark structure preserved`, () => {
      expect(ast(roundtrip(sample.markdown))).toEqual(ast(sample.markdown));
    });
  }
  for (const sample of corpus.filter(s => /(?:tilde.*fence|(?:backtick|tilde)-run-[345])/.test(s.id))) {
    it(`${sample.id}: same code nodes and contents after serialize/parse`, () => {
      const before = codec.parse(sample.markdown);
      const output = codec.serialize(before);
      expect(codec.parse(output)).toEqual(before);
      const block = before.content!.find(node => node.type === 'codeBlock')!;
      const character = block.attrs!.fenceCharacter as string;
      const code = block.content?.map(node => node.text ?? '').join('') ?? '';
      const runs = code.match(character === '`' ? /`+/g : /~+/g) ?? [];
      expect(output.match(/^[`~]+/)?.[0]).toBe(character.repeat(Math.max(3, ...runs.map(run => run.length + 1))));
    });
  }
  for (const sample of corpus.filter(s => s.markdown.includes('[['))) {
    it(`${sample.id}: wiki spelling byte-identical and IDs match the actual remark reader`, async () => {
      // Wiki prose is byte-identical. Code-block contents are checked above;
      // fence lengths themselves are deliberately canonicalized for safety.
      if (sample.id.startsWith('wiki-') || sample.id === 'long-line') expect(roundtrip(sample.markdown)).toBe(sample.markdown);
      const ids: string[] = [];
      visit(linkNodeRefs(await markdownToTree(sample.markdown)), 'element', node => {
        const href = node.properties.href;
        if (node.tagName === 'a' && typeof href === 'string' && href.startsWith(NODE_HREF)) ids.push(href.slice(NODE_HREF.length));
      });
      expect(editorWikiIds(codec.parse(sample.markdown))).toEqual(ids);
      expect(editorWikiIds(codec.parse(roundtrip(sample.markdown)))).toEqual(ids);
    });
  }
  it('original 36 samples have <=8 other changes, all recorded exactly', () => {
    expect(corpus.slice(0, 36)).toHaveLength(36);
    const remaining = changes();
    expect(remaining.filter(s => corpus.slice(0, 36).some(c => c.id === s.id)).length).toBeLessThanOrEqual(8);
    expect(JSON.parse(readFileSync(new URL('remaining-changes.json', fixtures), 'utf8'))).toEqual(remaining);
  });
  it('serializes edited nodes rather than returning the input document', () => {
    const doc = codec.parse('**앞 [[id]] 뒤**');
    const edit = (node: JSONContent) => {
      if (node.type === 'text') node.text = node.text?.replace('앞', '수정');
      node.content?.forEach(edit);
    };
    edit(doc);
    expect(codec.serialize(doc)).toBe('**수정 [[id]] 뒤**');
  });
});
