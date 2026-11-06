// usage: node typetest.mjs <candidate-dir> <tsc-path> ; prints per-check verdicts
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [dir, tsc, label, suite='assertions.ts'] = process.argv.slice(2);
const root = new URL('.', import.meta.url).pathname;
copyFileSync(root + suite, resolve(dir, 'src/' + suite));
const t0 = performance.now();
const r = spawnSync(process.execPath.endsWith('node') && tsc.endsWith('.js') ? process.execPath : tsc, tsc.endsWith('.js') ? [tsc, '-p', dir, '--pretty', 'false'] : ['-p', dir, '--pretty', 'false'], { encoding: 'utf8', maxBuffer: 1e8 });
const ms = Math.round(performance.now() - t0);
const out = r.stdout + r.stderr;
const src = readFileSync(root + suite, 'utf8').split('\n');
const lineToCheck = {}; let cur;
src.forEach((l, i) => { const m = l.match(/^\/\*([TS]\d+) (.*?)\s*\*\//); if (m) cur = m[1] + ' ' + m[2]; lineToCheck[i + 1] = cur; });
const checks = [...new Set(Object.values(lineToCheck).filter(Boolean))];
const failed = {}; const other = [];
for (const l of out.split('\n')) {
  const m = l.match(new RegExp('src/' + suite.replace('.','\\.') + '\\((\\d+),\\d+\\): error (TS\\d+): (.*)'));
  if (m) { (failed[lineToCheck[m[1]]] ??= []).push(m[2] + ' ' + m[3].slice(0, 110)); continue; }
  if (/error TS/.test(l)) other.push(l.slice(0, 200));
}
const pass = checks.filter(c => !failed[c]).length;
console.log(`${label ?? dir}: ${pass}/${checks.length} pass, tsc exit ${r.status}, ${ms} ms, other errors ${other.length}`);
for (const [c, e] of Object.entries(failed)) console.log('  FAIL', c, '::', e[0]);
for (const o of other.slice(0, 12)) console.log('  OTHER', o);
if (other.length > 12) console.log('  ... +', other.length - 12);
