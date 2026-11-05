import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import { createMarkdownCodec } from '../../src/editor/index.ts';
import { disallowedTypes, plainTextSlice, safeHref } from '../../src/editor/safety.ts';

const fixtures = new URL('../fixtures/editor/', import.meta.url);
type Paste = { id: string; html?: string; text?: string };
const pastes = JSON.parse(readFileSync(new URL('malicious-paste.json', fixtures), 'utf8')) as Paste[];
const hostileBody = readFileSync(new URL('hostile-body.md', fixtures), 'utf8');
const codec = createMarkdownCodec();

// Design 4.5 "schema": the allow-list, as the design lists it. `literal*`, `sourceEntity` and `referenceDefinition` carry Markdown that the
// editor does not interpret (raw HTML, entities, link definitions) as text; they render a text child and never an element of their own.
const NODES = ['doc', 'text', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'codeBlock',
  'horizontalRule', 'hardBreak', 'table', 'table_row', 'table_header', 'table_cell', 'wikiLink',
  'literalInline', 'literalBlock', 'sourceEntity', 'sourceImage', 'referenceDefinition'];
const MARKS = ['bold', 'italic', 'strike', 'code', 'link', 'sourceSyntax'];
const types = (node: JSONContent, out = new Set<string>()): Set<string> => {
  out.add(node.type!);
  node.marks?.forEach(mark => out.add(mark.type));
  node.content?.forEach(child => types(child, out));
  return out;
};

describe('M0a editor safety (design 4.5)', () => {
  it('the editor schema is the allow-list: no image, no other node or mark', () => {
    const schema = getSchema(codec.extensions);
    expect(Object.keys(schema.nodes).sort()).toEqual([...NODES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...MARKS].sort());
  });

  it('disallowedTypes names every node or mark outside the allow-list', () => {
    expect(disallowedTypes({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] })).toEqual(['image']);
    expect(disallowedTypes({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'underline' }] }] }] })).toEqual(['underline']);
    expect(disallowedTypes(codec.parse('# a\n\n- [ ] b\n\n| a |\n| - |\n| b |\n\n[[id]]'))).toEqual([]);
  });

  for (const sample of [...pastes.filter(p => p.text !== undefined && p.html === undefined), { id: 'hostile-body', text: hostileBody }]) {
    it(`${sample.id}: Markdown text parses to allow-listed nodes only, before and after saving`, () => {
      const doc = codec.parse(sample.text!);
      expect(disallowedTypes(doc)).toEqual([]);
      const saved = codec.serialize(doc);
      expect(disallowedTypes(codec.parse(saved))).toEqual([]);
      // Nothing is dropped silently: raw HTML the author wrote is still in the saved text, as text.
      if (sample.text!.includes('<script>')) expect(saved).toContain('<script>');
      expect(types(doc).has('image')).toBe(false);
    });
  }

  it('an image inside a paragraph is kept as source text instead of failing to parse', () => {
    const markdown = 'before ![alt](https://evil.example/x.png "t") after';
    const doc = codec.parse(markdown);
    expect(types(doc)).toContain('sourceImage');
    expect(codec.serialize(doc)).toBe(markdown);
  });

  it('a lone image is source text too, so no <img> can be built from Markdown', () => {
    const markdown = '![alt](https://evil.example/x.png)';
    expect(types(codec.parse(markdown))).not.toContain('image');
    expect(codec.serialize(codec.parse(markdown))).toBe(markdown);
  });

  it('only http and https links survive', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com/')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example/', '/relative', '#frag', '', 'java\nscript:alert(1)'])
      expect(safeHref(bad), bad).toBeNull();
  });

  it('plain-text paste is parsed as Markdown, and its raw HTML and bad links stay inert', () => {
    const schema = getSchema(codec.extensions);
    const slice = plainTextSlice(schema, codec, 'some **bold** [x](javascript:alert(1)) <script>alert(1)</script> [[e:topic:m0c]]');
    const json = slice.content.toJSON() as JSONContent[];
    const doc: JSONContent = { type: 'doc', content: json };
    expect(disallowedTypes(doc)).toEqual([]);
    expect(types(doc)).toContain('bold');
    expect(types(doc)).toContain('wikiLink');
    expect(types(doc)).not.toContain('link');
    expect(slice.openStart).toBe(1);
  });
});
