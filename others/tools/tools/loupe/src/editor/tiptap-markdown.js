// Offline adapters for installed Tiptap 3.32.0 / marked (2026-11-04).
// Use extension parse/render hooks, not an input-document cache or a post-save
// string replacement. Source syntax belongs to the corresponding editable node.
import { Mark, Node } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Bold } from '@tiptap/extension-bold';
import { Italic } from '@tiptap/extension-italic';
import { Strike } from '@tiptap/extension-strike';
import { CodeBlock } from '@tiptap/extension-code-block';
import { BulletList, ListItem, TaskList, TaskItem } from '@tiptap/extension-list';
import { Link } from '@tiptap/extension-link';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Marked, Tokenizer } from 'marked';
import { decodeString } from 'micromark-util-decode-string';

export function markdownEngine() {
  const engine = new Marked();
  // Rename native tokens before MarkdownManager's special cases: those split
  // mixed lists and parse HTML using a DOM when one is available.
  engine.use({ tokenizer: Object.fromEntries([
    ['list', 'loupeList'], ['html', 'literalBlock'], ['tag', 'literalInline'],
  ].map(([method, type]) => [method, function (source) {
    const token = Tokenizer.prototype[method].call(this, source);
    return token ? { ...token, type } : false;
  }])) });
  // An image is an attachment the KB does not store (design 4.4). Its token is renamed so that neither Tiptap's paragraph handler (which turns a
  // lone image into a block node) nor an image extension sees it: sourceImage keeps the spelling as inert text.
  const asSource = token => token?.type === 'image' ? { ...token, type: 'sourceImage' } : token;
  engine.use({ tokenizer: { reflink(source, links) { return asSource(Tokenizer.prototype.reflink.call(this, source, links)) || false; } } });
  engine.use({ tokenizer: { link(source) {
    const native = Tokenizer.prototype.link.call(this, source);
    if (native || !source.startsWith('[') || !source.includes('[[')) return asSource(native) || false;
    // marked's native label grammar cannot nest [[...]] inside [label](url).
    // Let that same parser read an equal-length masked label, then restore it
    // and lex its inline children with inLink set (as the native parser does).
    const originals = new Map();
    let codepoint = 0xE010;
    const masked = source.replace(/\[\[[^\]\n]+\]\]/g, raw => {
      while (source.includes(String.fromCodePoint(codepoint))) codepoint++;
      const key = String.fromCodePoint(codepoint++).repeat(raw.length);
      originals.set(key, raw);
      return key;
    });
    const token = Tokenizer.prototype.link.call(this, masked);
    if (!token) return false;
    const restore = value => typeof value === 'string'
      ? [...originals].reduce((text, [key, raw]) => text.replaceAll(key, raw), value) : value;
    token.raw = source.slice(0, token.raw.length);
    token.text = restore(token.text);
    token.href = restore(token.href);
    token.title = restore(token.title);
    const wasInLink = this.lexer.state.inLink;
    this.lexer.state.inLink = true;
    try { token.tokens = this.lexer.inlineTokens(token.text); }
    finally { this.lexer.state.inLink = wasInLink; }
    return asSource(token);
  } } });
  return engine;
}

const internal = value => ({ default: value, rendered: false });
const inlineSourceTypes = new Set(['wikiLink', 'literalInline', 'sourceEntity', 'sourceImage']);
// MarkdownManager 3.32.0 applies marks only to text and closes mark runs at
// atoms. Serialize inline source atoms as transparent source-marked text in a
// temporary JSON tree so emphasis/link runs remain continuous. The editor
// document is unchanged. The code flag only disables escaping for this mark;
// its renderer emits no delimiters. Never apply it to ordinary user text.
const sourceSyntax = Mark.create({
  name: 'sourceSyntax', code: true, parseHTML: () => [],
  renderHTML: () => ['span', 0],
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
});
function serializationTree(node) {
  if (inlineSourceTypes.has(node.type)) return { type: 'text', text: node.attrs.source,
    marks: [...(node.marks ?? []), { type: 'sourceSyntax' }] };
  return node.content ? { ...node, content: node.content.map(serializationTree) } : node;
}
const document = Document.extend({
  renderMarkdown: (node, h) => h.renderChildren((node.content ?? []).map(serializationTree), '\n\n'),
});
function markInline(nodes, type, attrs) {
  return nodes.map(node => ({ ...node, marks: [...(node.marks ?? []), { type, ...(attrs ? { attrs } : {}) }] }));
}
const emphasis = [Bold, Italic, Strike].map(extension => extension.extend({
  parseMarkdown(token, h) { return markInline(h.parseInline(token.tokens ?? []), this.name); },
}));
export function safeFence(value, character = '`') {
  const runs = value.match(character === '`' ? /`+/g : /~+/g) ?? [];
  return character.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
}
const codeBlock = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), fenceCharacter: internal('`'), info: internal(''), sourceLanguage: internal(null) };
  },
  parseMarkdown(token, h) {
    const marker = token.raw?.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/);
    return h.createNode('codeBlock', {
      language: token.lang?.split(/\s/)[0] || null,
      sourceLanguage: token.lang?.split(/\s/)[0] || null,
      fenceCharacter: marker?.[1][0] ?? '`', info: marker?.[2] ?? '',
    }, token.text ? [h.createTextNode(token.text)] : []);
  },
  renderMarkdown(node, h) {
    const text = h.renderChildren(node.content ?? []);
    // Backticks in an edited info string require a tilde fence (CommonMark).
    const originalInfo = node.attrs?.info ?? '';
    const info = node.attrs?.language === node.attrs?.sourceLanguage
      ? originalInfo : (node.attrs?.language ?? '') + (originalInfo.match(/\s[\s\S]*$/)?.[0] ?? '');
    const character = info.includes('`') ? '~' : node.attrs?.fenceCharacter || '`';
    const fence = safeFence(text, character);
    return `${fence}${info}\n${text}\n${fence}`;
  },
});

// Keep the native loose-list separator and mixed task/non-task membership.
const listItem = ListItem.extend({
  parseMarkdown(token, h) {
    const clean = { ...token, tokens: token.tokens?.filter(t => t.type !== 'checkbox') };
    const item = this.parent(clean, h);
    return token.task ? { ...item, type: 'taskItem', attrs: { checked: token.checked } } : item;
  },
});
const bulletList = BulletList.extend({
  content: '(listItem | taskItem)+',
  markdownTokenName: 'loupeList',
  addAttributes: () => ({ loose: internal(false) }),
  parseMarkdown(token, h) {
    const type = token.ordered ? 'orderedList' : token.items?.every(item => item.task) ? 'taskList' : 'bulletList';
    return h.createNode(type, { start: token.start || 1, loose: token.loose }, h.parseChildren(token.items ?? []));
  },
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], node.attrs?.loose ? '\n\n' : '\n'),
});
const taskList = TaskList.extend({
  // Use marked's native GFM list lexer for both homogeneous and mixed lists.
  markdownTokenizer: undefined,
  addAttributes: () => ({ loose: internal(false) }),
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], node.attrs?.loose ? '\n\n' : '\n'),
});

// Same public-ID rule as loupe/src/ids.ts:13-19. Alias syntax is preserved,
// but only the complete bracket contents accepted by the reader yield an ID.
export function wikiId(body) {
  return body && body.length <= 512 && !/[\u0000-\u001f\u007f/?#\\\s\]]/u.test(body)
    && body !== '.' && body !== '..' ? body : null;
}
const wikiLink = Node.create({
  name: 'wikiLink', inline: true, group: 'inline', atom: true,
  addAttributes: () => ({ source: internal(''), id: internal(null), value: internal('') }),
  // Markdown only: pasted HTML cannot create trusted wiki nodes.
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', { class: 'wiki-link', 'data-wiki-id': node.attrs.id ?? '' }, node.attrs.value],
  markdownTokenizer: {
    name: 'wikiLink', level: 'inline', start: '[[',
    tokenize(source) {
      const match = /^\[\[([^\]\n]+)\]\]/.exec(source);
      return match ? { type: 'wikiLink', raw: match[0], body: match[1] } : undefined;
    },
  },
  parseMarkdown: (token, h) => h.createNode('wikiLink', {
    source: token.raw, value: token.body, id: wikiId(token.body),
  }),
  renderMarkdown: node => node.attrs.source,
});

// Raw HTML and source entities are inert text in the editor; the serializer
// retains their Markdown spelling. DOM specs take text children, never HTML.
const literal = (name, block) => Node.create({
  name, group: block ? 'block' : 'inline', inline: !block, atom: true,
  addAttributes: () => ({ source: internal(''), value: internal('') }),
  parseHTML: () => [],
  renderHTML: ({ node }) => [block ? 'div' : 'span', {}, node.attrs.value],
  parseMarkdown: (token, h) => h.createNode(name, {
    source: block ? token.raw.replace(/\n$/, '') : token.raw,
    value: block ? token.raw.replace(/\n$/, '') : token.value ?? token.raw,
  }),
  renderMarkdown: node => node.attrs.source,
});
const entity = literal('sourceEntity', false).extend({
  markdownTokenizer: {
    name: 'sourceEntity', level: 'inline',
    start: source => source.search(/&(?:#\d{1,7}|#x[\da-f]{1,6}|[\da-z]{1,31});/i),
    tokenize(source) {
      const match = /^&(?:#\d{1,7}|#x[\da-f]{1,6}|[\da-z]{1,31});/i.exec(source);
      if (!match || decodeString(match[0]) === match[0]) return;
      return { type: 'sourceEntity', raw: match[0], value: decodeString(match[0]) };
    },
  },
});

const http = href => { try { return ['http:', 'https:'].includes(new URL(href).protocol); } catch { return false; } };
const link = Link.extend({
  addAttributes() { return { ...this.parent?.(), reference: internal(null), referenceHref: internal(null),
    referenceTitle: internal(null), referenceLabel: internal(null) }; },
  parseMarkdown(token, h) {
    const content = h.parseInline(token.tokens ?? []);
    if (!http(token.href)) return content;
    // Keep full/collapsed/shortcut reference spelling while text stays editable.
    const reference = token.raw?.startsWith('[') && !/^\[[\s\S]*\]\(/.test(token.raw)
      ? (token.raw.match(/\]([\s\S]*)$/)?.[1] ?? '') : null;
    return markInline(content, 'link', { href: token.href, title: token.title || null, reference,
      referenceHref: token.href, referenceTitle: token.title || null, referenceLabel: token.text });
  },
  renderMarkdown(node, h, context) {
    const text = h.renderChildren(node);
    if (!http(node.attrs?.href)) return text;
    if (node.attrs.reference !== null && node.attrs.reference !== undefined
      && node.attrs.href === node.attrs.referenceHref && node.attrs.title === node.attrs.referenceTitle) {
      const shortcut = node.attrs.reference === '' || node.attrs.reference === '[]';
      const suffix = shortcut && context?.meta?.markText !== node.attrs.referenceLabel
        ? `[${node.attrs.referenceLabel}]` : node.attrs.reference;
      return `[${text}]${suffix}`;
    }
    return this.parent(node, h);
  },
}).configure({ isAllowedUri: http, openOnClick: false, autolink: false,
  HTMLAttributes: { rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' } });
// ![alt](src) is an attachment, which the KB does not take (design 4.4): keep the author's spelling as inert text, never an <img>.
const sourceImage = literal('sourceImage', false);
const definition = literal('referenceDefinition', true).extend({ markdownTokenName: 'def' });
const hardBreak = HardBreak.extend({
  addAttributes: () => ({ marker: internal('  ') }),
  parseMarkdown: (token, h) => h.createNode('hardBreak', { marker: token.raw?.startsWith('\\') ? '\\' : '  ' }),
  renderMarkdown: node => `${node.attrs?.marker ?? '  '}\n`,
});

export const markdownSyntax = [document, sourceSyntax, ...emphasis, codeBlock, bulletList, listItem, taskList,
  TaskItem.configure({ nested: true }), wikiLink, literal('literalInline', false),
  literal('literalBlock', true), entity, sourceImage, link, definition, hardBreak];
