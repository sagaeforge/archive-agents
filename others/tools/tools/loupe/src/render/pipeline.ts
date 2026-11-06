// Markdown to a sanitized tree (design 9). raw HTML stays off; rehype-sanitize runs last among untrusted steps.
// Only trusted transforms (Shiki) may run after it. The result holds no script and no remote resource.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';
import { parseKbId } from '../ids.ts';
import { NODE_HREF } from './nodeHref.ts';

const BANNED = new Set(['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'link', 'style', 'script', 'form', 'base', 'meta']);

const attributes = Object.fromEntries(
  Object.entries(defaultSchema.attributes ?? {}).filter(([tag]) => !BANNED.has(tag)).map(([tag, list]) => [tag, (list ?? []).filter((a) => (Array.isArray(a) ? a[0] : a) !== 'style')]),
);

export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !BANNED.has(t)),
  attributes,
  protocols: { href: ['http', 'https'], cite: ['http', 'https'], longDesc: ['http', 'https'], src: [] },
  // `user-content-` stays on id and name: that is the DOM clobbering guard.
  strip: ['script', 'style'],
};

const hostOf = (src: unknown) => { try { return new URL(String(src)).host; } catch { return ''; } };

/** An image becomes the words `[이미지: alt, host]`, so no remote request can leave the page (design 9). */
function imagesToText() {
  return (tree: Root) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'img' || !parent || index === undefined) return;
      const alt = typeof node.properties.alt === 'string' ? node.properties.alt : '';
      const text: Text = { type: 'text', value: `[이미지: ${[alt, hostOf(node.properties.src)].filter(Boolean).join(', ') || '설명 없음'}]` };
      parent.children[index] = text;
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // clobberPrefix '' because rehype-sanitize adds its own: one `user-content-`, not two.
  .use(remarkRehype, { allowDangerousHtml: false, clobberPrefix: '' })
  .use(imagesToText)
  .use(rehypeSanitize, sanitizeSchema);

const WIKI = /\[\[([^\]\s]+)\]\]/g;
const slug = (id: string) => (id.startsWith('e:') ? id.split(':').slice(2).join(':') || id : id);

/** `[[id]]` in a first-party body is a link to that node (C 6.2). Runs after sanitize, and only an id that passes the id rule becomes a link. */
export function linkNodeRefs(tree: Root): Root {
  visit(tree, 'text', (node, index, parent) => {
    if (!parent || index === undefined || (parent.type === 'element' && ['code', 'pre', 'a'].includes(parent.tagName))) return;
    const parts: (Text | Element)[] = [];
    let at = 0;
    for (const m of node.value.matchAll(WIKI)) {
      const r = parseKbId(m[1]!);
      if (!r.ok) continue;
      if (m.index > at) parts.push({ type: 'text', value: node.value.slice(at, m.index) });
      parts.push({ type: 'element', tagName: 'a', properties: { href: NODE_HREF + r.id }, children: [{ type: 'text', value: slug(r.id) }] });
      at = m.index + m[0].length;
    }
    if (parts.length === 0) return;
    if (at < node.value.length) parts.push({ type: 'text', value: node.value.slice(at) });
    parent.children.splice(index, 1, ...parts);
    return index + parts.length;
  });
  return tree;
}

export async function markdownToTree(text: string): Promise<Root> {
  const tree = processor.parse(text);
  return (await processor.run(tree)) as Root;
}
