// A minimal hast serializer for assertions, so the tests do not add a dependency. Text is escaped the way a browser would need it.
import type { Element, Root, RootContent } from 'hast';

const escapeText = (s: string) => s.replaceAll('&', '&#x26;').replaceAll('<', '&#x3C;');
const escapeAttr = (s: string) => s.replaceAll('&', '&#x26;').replaceAll('"', '&#x22;');
const attr = (k: string) => ({ className: 'class', ariaLabel: 'aria-label', ariaDescribedBy: 'aria-describedby', dataFootnoteRef: 'data-footnote-ref', dataFootnotes: 'data-footnotes' } as Record<string, string>)[k] ?? k;

function node(n: RootContent): string {
  if (n.type === 'text') return escapeText(n.value);
  if (n.type !== 'element') return '';
  const el = n as Element;
  const props = Object.entries(el.properties ?? {}).map(([k, v]) => {
    if (v === null || v === undefined || v === false) return '';
    const value = Array.isArray(v) ? v.join(' ') : v === true ? '' : String(v);
    return ` ${attr(k)}="${escapeAttr(value)}"`;
  }).join('');
  return `<${el.tagName}${props}>${el.children.map(node).join('')}</${el.tagName}>`;
}
export const toHtml = (t: Root) => t.children.map(node).join('');

export function propertyNames(t: Root): string[] {
  const out = new Set<string>();
  const walk = (n: RootContent) => { if (n.type === 'element') { for (const k of Object.keys(n.properties ?? {})) out.add(k); n.children.forEach(walk); } };
  t.children.forEach(walk);
  return [...out];
}
