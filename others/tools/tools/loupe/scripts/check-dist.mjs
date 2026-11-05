// Fails the build when the bundle carries a local path. The stamp and any other value baked in at build time must not name the home
// directory or where the KB is checked out: whatever can read /assets can read them (design 9, 10).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LOCAL = [/\/home\/[A-Za-z0-9._-]+\//, /\/Users\/[A-Za-z0-9._-]+\//, /[A-Za-z]:\\Users\\/, /\/root\//, /\/mnt\/[a-z]\//];

/** @returns {{file: string, match: string}[]} */
export function findLocalPaths(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|css|html|json|map|txt|svg)$/i.test(name)) continue;
      const text = readFileSync(p, 'utf8');
      for (const re of LOCAL) { const m = re.exec(text); if (m) hits.push({ file: p, match: m[0] }); }
    }
  };
  walk(dir);
  return hits;
}

// Design 11: sigma + graphology stay within 130 KB gz and load with the graph route only.
export const GRAPH_VENDOR_BUDGET_GZ = 130 * 1024;
// A sigma setting name: it can only be in the entry if sigma or the view got into it.
const SIGMA_MARKER = 'hideEdgesOnMove';

/** @returns {{ok: boolean, gzBytes: number, problems: string[]}} */
export function checkGraphBundle(dir) {
  const assets = join(dir, 'assets');
  const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const vendor = files.filter((f) => f.startsWith('graph-vendor-'));
  const problems = [];
  if (vendor.length !== 1) problems.push(`expected one graph-vendor chunk, found ${vendor.length}`);
  const gzBytes = vendor.reduce((sum, f) => sum + gzipSync(readFileSync(join(assets, f))).length, 0);
  if (gzBytes > GRAPH_VENDOR_BUDGET_GZ) problems.push(`graph-vendor is ${gzBytes} bytes gz, over ${GRAPH_VENDOR_BUDGET_GZ}`);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  if (html.includes('graph-vendor')) problems.push('index.html loads graph-vendor: it must wait for the graph route');
  const entry = /src="\.\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1];
  if (!entry) problems.push('no entry script in index.html');
  else {
    // The only way from the entry to the vendor chunk is a dynamic import: no static import, no sigma source in the entry.
    const text = readFileSync(join(assets, entry), 'utf8');
    if (/from\s*["']\.\/graph-vendor/.test(text) || /import\s*["']\.\/graph-vendor/.test(text)) problems.push('the entry imports graph-vendor statically');
    if (text.includes(SIGMA_MARKER)) problems.push('sigma source is in the entry chunk');
  }
  return { ok: problems.length === 0, gzBytes, problems };
}

// Design v2 4.2 item 5: the editor (Tiptap, ProseMirror) is its own chunk, fetched when a window switches to editing. ProseMirror's class name is in
// every build of it and in nothing else the app ships.
const EDITOR_MARKER = 'ProseMirror';
const EDITOR_CSS_MARKER = '.loupe-editor';
const gz = (text) => gzipSync(text).length;
const chunkName = (file) => file.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '.$1');
/** Chunks a chunk imports at load time. A dynamic `import("./x.js")` is not one: it has a parenthesis, which these patterns do not accept. */
const staticImports = (text) => [...text.matchAll(/(?:\bimport|\bexport)\s*(?:[^'"()]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);

/** @returns {{ok: boolean, problems: string[], firstScreen: {name: string, gzBytes: number}[], editor: {name: string, gzBytes: number}[], firstScreenGzBytes: number, editorGzBytes: number}} */
export function checkEditorBundle(dir) {
  const assets = join(dir, 'assets');
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const text = new Map(readdirSync(assets).map((f) => [f, readFileSync(join(assets, f), 'utf8')]));
  const problems = [];
  // The first screen is the entry, every chunk reachable from it by static imports, and what index.html preloads or links.
  const first = new Set();
  const visit = (file) => {
    if (first.has(file) || !text.has(file)) return;
    first.add(file);
    for (const dep of staticImports(text.get(file))) visit(dep);
  };
  for (const m of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)) visit(m[1]);
  const carries = (file) => file.endsWith('.js') && text.get(file).includes(EDITOR_MARKER);
  const early = [...first].filter(carries);
  if (early.length) problems.push(`editor code is in the first screen: ${early.join(', ')}`);
  const carriers = [...text.keys()].filter(carries);
  if (!carriers.length) problems.push('no editor chunk found: the check would pass without testing anything');
  // The editor's own entry chunk (the one the dynamic import names) does not carry the marker itself; it imports the chunk that does.
  const reachesCarrier = (file, seen = new Set()) => {
    if (seen.has(file) || !text.has(file)) return false;
    seen.add(file);
    return carries(file) || staticImports(text.get(file)).some((dep) => reachesCarrier(dep, seen));
  };
  const editorJs = [...text.keys()].filter((f) => f.endsWith('.js') && reachesCarrier(f));
  // What the editor window fetches that the first screen did not: its own chunks, their static imports, and the CSS only they use.
  const editorSet = new Set();
  const collect = (file) => {
    if (editorSet.has(file) || first.has(file) || !text.has(file)) return;
    editorSet.add(file);
    for (const dep of staticImports(text.get(file))) collect(dep);
  };
  editorJs.forEach(collect);
  for (const [file, body] of text) if (file.endsWith('.css') && !first.has(file) && body.includes(EDITOR_CSS_MARKER)) editorSet.add(file);
  const sized = (files) => [...files].map((file) => ({ name: chunkName(file), gzBytes: gz(text.get(file)) })).sort((a, b) => a.name.localeCompare(b.name));
  const firstScreen = sized(first), editor = sized(editorSet);
  const sum = (list) => list.reduce((n, c) => n + c.gzBytes, 0);
  return { ok: problems.length === 0, problems, firstScreen, editor, firstScreenGzBytes: sum(firstScreen), editorGzBytes: sum(editor) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
  const hits = findLocalPaths(dir);
  const graph = checkGraphBundle(dir);
  const editor = checkEditorBundle(dir);
  if (hits.length === 0 && graph.ok && editor.ok) {
    console.log(`check-dist ok: no local path in ${dir}, graph-vendor ${(graph.gzBytes / 1024).toFixed(1)} KB gz, editor chunks +${(editor.editorGzBytes / 1024).toFixed(1)} KB gz (first screen ${(editor.firstScreenGzBytes / 1024).toFixed(1)} KB gz)`);
    // The editor's gzip increase is a recorded measurement, not a gate (design v2 4.1 item 5). Only the default dist is recorded.
    if (!process.argv[2]) writeFileSync(new URL('../test/fixtures/editor/bundle-size.json', import.meta.url), JSON.stringify({
      tiptap: '3.32.0', editorGzBytes: editor.editorGzBytes, editorGzKB: Number((editor.editorGzBytes / 1024).toFixed(1)),
      firstScreenGzBytes: editor.firstScreenGzBytes, editorChunks: editor.editor, firstScreenChunks: editor.firstScreen,
    }, null, 2) + '\n');
    process.exit(0);
  }
  if (hits.length) console.error(`check-dist FAILED: local paths in the bundle\n${hits.map((h) => `  ${h.file}: ${h.match}`).join('\n')}`);
  if (!graph.ok) console.error(`check-dist FAILED: ${graph.problems.join('; ')}`);
  if (!editor.ok) console.error(`check-dist FAILED: ${editor.problems.join('; ')}`);
  process.exit(1);
}
