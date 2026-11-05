import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEditorBundle } from '../../scripts/check-dist.mjs';

// A miniature dist: index.html -> entry -> (static) shared; entry -> (dynamic) editor -> (static) editor-vendor + shared.
function dist(files: Record<string, string>, html = '<script type="module" src="./assets/index-AAAAAAAA.js"></script>') {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), html);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), text);
  return dir;
}
const pad = (n: number) => Array.from({ length: n }, (_, i) => `x${i * 7919 % 10007}`).join(',');
const good = {
  'index-AAAAAAAA.js': 'import{r}from"./shared-BBBBBBBB.js";const e=()=>import("./EditorWindow-CCCCCCCC.js");export{e}',
  'shared-BBBBBBBB.js': `export const r=1;/*${pad(50)}*/`,
  'EditorWindow-CCCCCCCC.js': 'import{r}from"./shared-BBBBBBBB.js";import{p}from"./editor-vendor-DDDDDDDD.js";export default p+r',
  'editor-vendor-DDDDDDDD.js': `export const p="ProseMirror";/*${pad(400)}*/`,
};

describe('check-dist editor chunk (design v2 4.2 item 5)', () => {
  it('passes when the editor is only reached by a dynamic import, and measures what the editor window adds', () => {
    const r = checkEditorBundle(dist(good));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.editor.map(c => c.name).sort()).toEqual(['EditorWindow.js', 'editor-vendor.js']);
    expect(r.editorGzBytes).toBeGreaterThan(0);
    expect(r.firstScreen.map(c => c.name).sort()).toEqual(['index.js', 'shared.js']);
  });

  it('fails when the entry statically imports a chunk that carries editor code', () => {
    const r = checkEditorBundle(dist({ ...good, 'index-AAAAAAAA.js': `import{r}from"./shared-BBBBBBBB.js";import"./editor-vendor-DDDDDDDD.js";${good['index-AAAAAAAA.js']}` }));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/editor code .*first screen/);
  });

  it('fails when index.html preloads the editor', () => {
    const r = checkEditorBundle(dist(good, '<script type="module" src="./assets/index-AAAAAAAA.js"></script><link rel="modulepreload" href="./assets/editor-vendor-DDDDDDDD.js">'));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/first screen/);
  });

  it('fails when there is no editor chunk at all, so the check cannot pass vacuously', () => {
    const r = checkEditorBundle(dist({ 'index-AAAAAAAA.js': 'console.log(1)' }));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/no editor chunk/);
  });
});
