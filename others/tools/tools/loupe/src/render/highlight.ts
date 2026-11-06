// Shiki runs after sanitize and only inside the worker. shiki/core with the JS regex engine has no WASM, so the CSP stays as it is (design 9).
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';

type Loader = () => Promise<{ default: LanguageRegistration[] }>;
const typescript: Loader = () => import('shiki/langs/typescript.mjs');
const javascript: Loader = () => import('shiki/langs/javascript.mjs');
const shell: Loader = () => import('shiki/langs/shellscript.mjs');
const yaml: Loader = () => import('shiki/langs/yaml.mjs');
const json: Loader = () => import('shiki/langs/json.mjs');
const LANGS = new Map<string, [string, Loader]>([
  ['ts', ['typescript', typescript]], ['typescript', ['typescript', typescript]],
  ['tsx', ['tsx', () => import('shiki/langs/tsx.mjs')]], ['jsx', ['jsx', () => import('shiki/langs/jsx.mjs')]],
  ['js', ['javascript', javascript]], ['javascript', ['javascript', javascript]], ['mjs', ['javascript', javascript]],
  ['json', ['json', json]], ['jsonc', ['json', json]],
  ['yaml', ['yaml', yaml]], ['yml', ['yaml', yaml]],
  ['bash', ['shellscript', shell]], ['sh', ['shellscript', shell]], ['shell', ['shellscript', shell]], ['zsh', ['shellscript', shell]],
  ['python', ['python', () => import('shiki/langs/python.mjs')]], ['py', ['python', () => import('shiki/langs/python.mjs')]],
  ['rust', ['rust', () => import('shiki/langs/rust.mjs')]], ['go', ['go', () => import('shiki/langs/go.mjs')]],
  ['sql', ['sql', () => import('shiki/langs/sql.mjs')]], ['toml', ['toml', () => import('shiki/langs/toml.mjs')]],
  ['diff', ['diff', () => import('shiki/langs/diff.mjs')]], ['css', ['css', () => import('shiki/langs/css.mjs')]],
  ['html', ['html', () => import('shiki/langs/html.mjs')]], ['xml', ['xml', () => import('shiki/langs/xml.mjs')]],
]);

const MAX_CODE_CHARS = 20_000;
let highlighter: Promise<HighlighterCore> | null = null;
const getHighlighter = () => (highlighter ??= createHighlighterCore({
  themes: [import('shiki/themes/github-light.mjs')],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
}));
const loaded = new Set<string>();

const textOf = (el: Element) => el.children.map((c) => (c.type === 'text' ? (c as Text).value : '')).join('');
const langOf = (code: Element) => {
  const cls = code.properties.className;
  const list = Array.isArray(cls) ? cls : [];
  const name = list.map(String).find((c) => c.startsWith('language-'));
  return name?.slice('language-'.length).toLowerCase() ?? null;
};

/** Replaces fenced code in place. A language that is not in the table stays plain text. */
export async function highlightTree(tree: Root): Promise<Root> {
  const blocks: { parent: Element; code: Element; lang: [string, Loader] }[] = [];
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'pre') return;
    const code = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
    const lang = code ? langOf(code) : null;
    const entry = lang ? LANGS.get(lang) : undefined;
    if (code && entry && textOf(code).length <= MAX_CODE_CHARS) blocks.push({ parent: node, code, lang: entry });
  });
  if (blocks.length === 0) return tree;
  const h = await getHighlighter();
  for (const b of blocks) {
    const [name, load] = b.lang;
    if (!loaded.has(name)) { await h.loadLanguage(await load()); loaded.add(name); }
    const out = h.codeToHast(textOf(b.code).replace(/\n$/, ''), { lang: name, theme: 'github-light' });
    const pre = out.children[0];
    if (pre?.type === 'element') { b.parent.properties = pre.properties; b.parent.children = pre.children; }
  }
  return tree;
}
