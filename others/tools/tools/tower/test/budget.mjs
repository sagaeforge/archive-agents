// Section 11 budget: core 400, total 500, counted like S1 (no blank lines, no comment-only lines).
// Lines are found through the TypeScript parser, so `//` inside a string or a template is code.
// Lines stay within the width of the S1 spike's style, which is what keeps the count honest.
// Also guards the 비목표: tools/tower knows nothing about its consumers.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src');
export const CORE = ['upstream.ts', 'merge.ts', 'config.ts', 'server.ts', 'log.ts'];
export const LIMITS = { core: 400, total: 500, width: 170 };

// Every line that holds at least one token of the parse tree. The S1 gateway counts 207 this way, as the design says.
export function countLines(text) {
  const file = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const code = new Set();
  const visit = (node) => {
    const children = node.getChildren(file);
    if (children.length) return children.forEach(visit);
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.getFullText(file).trim() === '') return undefined;
    const [first, last] = [node.getStart(file), node.getEnd() - 1].map((pos) => file.getLineAndCharacterOfPosition(pos).line);
    for (let line = first; line <= last; line += 1) code.add(line);
    return undefined;
  };
  visit(file);
  return code.size;
}

export function report() {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts')).sort();
  const modules = Object.fromEntries(files.map((f) => [f, countLines(readFileSync(join(SRC, f), 'utf8'))]));
  const core = CORE.reduce((n, f) => n + (modules[f] ?? 0), 0);
  const total = Object.values(modules).reduce((a, b) => a + b, 0);
  const wide = files.flatMap((f) => readFileSync(join(SRC, f), 'utf8').split('\n').flatMap((l, i) => (l.length > LIMITS.width ? [`${f}:${i + 1} is ${l.length} wide`] : [])));
  const sources = [...files.map((f) => join(SRC, f)), join(here, '../tower.example.json'), join(here, '../package.json')];
  const consumers = sources.flatMap((f) => (/loupe|knowledge|\bkb\b|kb:\/\/|sagae-knowloge/i.test(readFileSync(f, 'utf8')) ? [f] : []));
  return { modules, core, total, wide, consumers, ok: core <= LIMITS.core && total <= LIMITS.total && !wide.length && !consumers.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = report();
  for (const [file, lines] of Object.entries(r.modules)) console.log(`${String(lines).padStart(4)}  ${file}${CORE.includes(file) ? '' : '  (not core)'}`);
  console.log(`core ${r.core}/${LIMITS.core}, total ${r.total}/${LIMITS.total}`);
  for (const line of [...r.wide, ...r.consumers.map((f) => `names a consumer: ${f}`)]) console.log(line);
  process.exit(r.ok ? 0 : 1);
}
