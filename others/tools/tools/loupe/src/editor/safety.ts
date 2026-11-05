// Editor safety (design v2 4.5). Everything that decides what a paste or a foreign body may become lives here, apart from the React view.
import type { JSONContent } from '@tiptap/core';
import { Slice, type Schema } from '@tiptap/pm/model';
import type { createMarkdownCodec } from './index.ts';

/** Design 4.5 "schema": the allow-list. `literal*`, `sourceEntity`, `sourceImage` and `referenceDefinition` hold Markdown the editor does not
 *  interpret (raw HTML, entities, images, link definitions). They render a text child only, so those spellings fall to plain text. */
export const ALLOWED_NODES: ReadonlySet<string> = new Set(['doc', 'text', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList',
  'listItem', 'taskList', 'taskItem', 'codeBlock', 'horizontalRule', 'hardBreak', 'table', 'table_row', 'table_header', 'table_cell', 'wikiLink',
  'literalInline', 'literalBlock', 'sourceEntity', 'sourceImage', 'referenceDefinition']);
export const ALLOWED_MARKS: ReadonlySet<string> = new Set(['bold', 'italic', 'strike', 'code', 'link', 'sourceSyntax']);

/** Node and mark names in a document that are not on the allow-list. Empty means the document is inside it. */
export function disallowedTypes(doc: JSONContent): string[] {
  const out = new Set<string>();
  const visit = (node: JSONContent) => {
    if (node.type && !ALLOWED_NODES.has(node.type)) out.add(node.type);
    node.marks?.forEach(mark => { if (!ALLOWED_MARKS.has(mark.type)) out.add(mark.type); });
    node.content?.forEach(visit);
  };
  visit(doc);
  return [...out].sort();
}

/** `href` is kept only when it is an absolute http or https URL (design 4.5 "링크"). Anything else returns null: the caller keeps the text only. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  try { return ['http:', 'https:'].includes(new URL(href).protocol) ? href : null; } catch { return null; }
}

/** Plain-text paste is Markdown (design 4.5 "붙여넣기"). The result went through the same codec as a saved body, so it is inside the schema. */
export function plainTextSlice(schema: Schema, codec: Pick<ReturnType<typeof createMarkdownCodec>, 'parse'>, text: string): Slice {
  return Slice.maxOpen(schema.nodeFromJSON(codec.parse(text)).content);
}

// ---- HTML paste ----

/** Elements that are dropped together with their content. */
const DROPPED = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'img', 'picture', 'video',
  'audio', 'source', 'track', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'title', 'head', 'noscript',
  'template', 'portal', 'dialog', 'map', 'area', 'image', 'fencedframe', 'noembed', 'noframes', 'xmp', 'plaintext']);
/** Elements that are written out, without any attribute but `href` on `a`. Every other element is unwrapped: its children stay, the element goes. */
const KEPT = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'i', 'strong', 'b', 's',
  'del', 'strike', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
const VOID = new Set(['br', 'hr']);
/** Not the defense (the rebuild below is): an `on*=` attribute is renamed before parsing because Chrome compiles it even in a parser-only document,
 *  which the page's CSP then reports as a violation. Any spelling this misses is still dropped by `write`, and shows up as that report. */
const HANDLER_ATTRIBUTE = /([^\w-])(on[a-z]+)(\s*=)/gi;
/** Same reason for `<base>`: a parser-only document still reports `base-uri 'none'` when it sees one. */
const BASE_ELEMENT = /<(\/?)base\b/gi;
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

type TrustedTypesGlobal = { createPolicy(name: string, rules: { createHTML(s: string): string }): { createHTML(s: string): unknown }; defaultPolicy?: { createHTML(s: string): unknown } | null };
let parsePolicy: { createHTML(s: string): unknown } | null | undefined;
/** `DOMParser.parseFromString` is a Trusted Types sink. This one named policy hands the raw string to an inert document (no script runs, nothing
 *  loads) whose content is then rebuilt from the allow-list below; the string that leaves this module is that rebuilt one. */
function forInertParser(html: string): string {
  const types = (globalThis as { trustedTypes?: TrustedTypesGlobal }).trustedTypes;
  if (!types) return html;
  if (parsePolicy === undefined) {
    try { parsePolicy = types.createPolicy('loupe-paste-parse', { createHTML: s => s }); } catch { parsePolicy = types.defaultPolicy ?? null; }
  }
  return parsePolicy ? (parsePolicy.createHTML(html) as unknown as string) : html;
}

function write(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.localName;
  if (DROPPED.has(tag)) return '';
  const inner = [...el.childNodes].map(write).join('');
  if (!KEPT.has(tag)) return inner;
  if (VOID.has(tag)) return `<${tag}>`;
  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href'));
    return href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
  }
  return `<${tag}>${inner}</${tag}>`;
}

/** Design 4.5 "붙여넣기": every attribute is removed (`href` stays on `a`, http and https only), and img, svg, iframe, style, script, form and the
 *  other embedding elements are dropped with their content. The result is what ProseMirror's schema parser then reads. */
export function sanitizePastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(forInertParser(html.replace(HANDLER_ATTRIBUTE, '$1data-blocked-$2$3').replace(BASE_ELEMENT, '<$1x-base')), 'text/html');
  return [...doc.body.childNodes].map(write).join('');
}

/** True when the pasted or dropped HTML carried an image: the editor refuses attachments (design 4.4) and says so. */
export const hasImage = (html: string) => /<(img|picture|svg|image)\b/i.test(html);
