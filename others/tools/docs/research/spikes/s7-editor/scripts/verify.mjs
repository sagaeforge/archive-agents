import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ast, codeBlocks, readerIds, editorWikiIds } from './markdown-diagnostics.mjs';
import { modelLoader } from './model-roundtrip.mjs';
import { safeFence } from '../src/tiptap-markdown.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));
const results = JSON.parse(await read('results.json'));
const corpus = JSON.parse(await read('scripts/corpus.json'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
assert.equal(results.metadata.corpusSha256, sha256(await read('scripts/corpus.json')));
for (const name of ['milkdown', 'tiptap']) {
  const { ime, roundtrip, bundle } = results[name];
  assert.equal(roundtrip.samples.length, corpus.length);
  assert.equal(roundtrip.identical + roundtrip.normalizedOnly + roundtrip.failed, roundtrip.total);
  assert.equal(roundtrip.samples.filter(s => s.identical).length, roundtrip.identical);
  assert.equal(roundtrip.samples.filter(s => !s.identical && s.normalizedEqual).length, roundtrip.normalizedOnly);
  assert.equal(roundtrip.samples.filter(s => !s.normalizedEqual).length, roundtrip.failed);
  assert.equal(roundtrip.samples.filter(s => !s.astEqualDiagnosticOnly).length, roundtrip.structureChanged);
  for (const sample of roundtrip.samples) {
    const source = corpus.find(s => s.id === sample.id);
    assert.ok(source, sample.id);
    assert.equal(sample.input, source.markdown ?? source.repeat.repeat(source.count));
    assert.equal(sample.inputSha256, sha256(sample.input));
    assert.equal(sample.error, null, `${name}/${sample.id} load/serialization error`);
    assert.equal(sample.outputSha256, sha256(sample.output));
    assert.equal(sample.identical, Buffer.from(sample.input).equals(Buffer.from(sample.output)));
    assert.equal(sample.normalizedEqual, normalize(sample.input) === normalize(sample.output));
    assert.equal(sample.classification, sample.identical ? 'identical' : sample.normalizedEqual ? 'normalized-only' : 'failed');
    assert.equal(sample.astEqualDiagnosticOnly, ast(sample.input) === ast(sample.output));
    assert.deepEqual(sample.codeBlocks.input, codeBlocks(sample.input));
    assert.deepEqual(sample.codeBlocks.output, codeBlocks(sample.output));
    assert.equal(sample.codeBlocks.preserved, JSON.stringify(codeBlocks(sample.input)) === JSON.stringify(codeBlocks(sample.output)));
    if (sample.diff) {
      const input = Buffer.from(sample.input);
      const { inputByteOffset, removed, added } = sample.diff;
      assert.equal(input.subarray(inputByteOffset, inputByteOffset + Buffer.byteLength(removed)).toString(), removed);
      assert.equal(Buffer.concat([input.subarray(0, inputByteOffset), Buffer.from(added), input.subarray(inputByteOffset + Buffer.byteLength(removed))]).toString(), sample.output);
    }
  }
  let raw = 0, gzip = 0;
  for (const file of bundle.files) {
    const content = await read(`dist/${name}/${file.path}`);
    assert.equal(content.length, file.rawBytes);
    assert.equal(gzipSync(content, { level: 9 }).length, file.gzipBytes);
    assert.equal(sha256(content), file.sha256);
    raw += file.rawBytes; gzip += file.gzipBytes;
  }
  assert.equal(raw, bundle.total.rawBytes);
  assert.equal(gzip, bundle.total.gzipBytes);
  assert.equal(ime.cases.length, ime.total);
  assert.equal(ime.pass + ime.fail + ime.notRun, ime.total);
  if (ime.measured) {
    assert.equal(ime.cases.filter(c => c.pass).length, ime.pass);
    assert.equal(ime.cases.filter(c => !c.pass).length, ime.fail);
    assert.ok(ime.commandPositiveControls.every(c => c.pass), 'Slash/submit positive controls must execute outside composition');
  } else {
    assert.equal(ime.status, 'blocked');
    assert.equal(ime.pass, 0);
    assert.equal(ime.fail, 0);
    assert.ok(ime.cases.every(c => c.pass === null && c.finalText === null));
  }
  console.log(`${name}: corpus/diffs/bundle verified; IME ${ime.measured ? `${ime.pass}/${ime.total} pass` : `${ime.notRun} NOT RUN (blocked)`}`);
}
// Re-run the production Tiptap extension configuration, not only recorded data.
const load = await modelLoader('tiptap');
for (const sample of results.tiptap.roundtrip.samples) {
  const fresh = await load(sample.input);
  assert.equal(fresh.markdown, sample.output, `${sample.id}: stale serialized output`);
  assert.equal(ast(sample.input), ast(fresh.markdown), `${sample.id}: Markdown structure/content changed`);
  assert.deepEqual(await readerIds(sample.input), await readerIds(fresh.markdown), `${sample.id}: reader IDs changed`);
  assert.deepEqual(editorWikiIds(fresh.json), await readerIds(sample.input), `${sample.id}: editor/reader IDs differ`);
  assert.deepEqual(sample.wikiLinks.inputIds, await readerIds(sample.input));
  assert.deepEqual(sample.wikiLinks.outputIds, await readerIds(sample.output));
  assert.deepEqual(sample.wikiLinks.nodeIds, editorWikiIds(fresh.json));
  assert.equal(sample.wikiLinks.nodeIdsMatchReader, true);
  assert.equal(sample.wikiLinks.readerIdsPreserved, true);
  if (sample.id.startsWith('wiki-') || sample.id === 'long-line') {
    assert.equal(fresh.markdown, sample.input, `${sample.id}: wiki sample must be byte-identical`);
    assert.ok(!fresh.markdown.includes('\\[['), `${sample.id}: escaped wiki opening`);
  }
  if (/^(backtick|tilde)-run-[345]$/.test(sample.id) || sample.id === 'tilde-code-fence') {
    assert.deepEqual(codeBlocks(sample.input), codeBlocks(fresh.markdown));
    const block = fresh.json.content.find(node => node.type === 'codeBlock');
    const fence = fresh.markdown.match(/^[`~]+/)[0];
    assert.equal(fence, safeFence(block.content?.map(node => node.text).join('') ?? '', block.attrs.fenceCharacter));
  }
}
assert.ok(results.tiptap.roundtrip.failed <= 8);
assert.equal(results.tiptap.roundtrip.structureChanged, 0);
assert.equal(results.tiptap.roundtrip.originalCorpus.total, 36);
for (const character of ['`', '~']) {
  for (const length of [3, 4, 5]) assert.equal(safeFence(`a${character.repeat(length)}b`, character), character.repeat(length + 1));
}
// A modified document must serialize the edit, never a cached source document.
const { tiptapExtensions } = await import('../src/tiptap-extensions.js');
const { getSchema } = await import('@tiptap/core');
const { MarkdownManager } = await import('@tiptap/markdown');
const extensions = tiptapExtensions();
const manager = new MarkdownManager({ extensions, marked: extensions.find(e => e.name === 'markdown').options.marked });
const edited = manager.parse('```js meta\nold\n```\n\n[[id]]');
edited.content[0].content[0].text = 'new\n`````';
edited.content[0].attrs.language = 'ts';
edited.content[1].content.push({ type: 'text', text: ' edited' });
getSchema(extensions).nodeFromJSON(edited).check();
const savedEdit = manager.serialize(edited);
assert.deepEqual(codeBlocks(savedEdit), [{ language: 'ts', meta: 'meta', value: 'new\n`````' }]);
assert.ok(savedEdit.includes('[[id]] edited'));
const entityWithMark = await load('**앞 &copy; 뒤**');
assert.equal(entityWithMark.markdown, '**앞 &copy; 뒤**');
assert.equal(entityWithMark.text, '앞 © 뒤');
for (const source of ['<script>alert(1)</script>', '<em>plain</em>']) {
  const literal = await load(source);
  assert.ok(literal.text.includes(source));
  assert.ok(!JSON.stringify(literal.json).includes('"type":"italic"'));
}
for (const href of ['javascript:alert(1)', 'data:text/html,unsafe', 'mailto:a@example.invalid']) {
  const literal = await load(`[label](${href})`);
  assert.ok(!JSON.stringify(literal.json).includes('"type":"link"'));
  assert.equal(literal.text, 'label');
}
console.log('Tiptap live roundtrip: fences/wiki IDs/unchanged AST/failed <= 8 verified.');
assert.match(await readFile(new URL('README.md', root), 'utf8'), /## RESULT/);
console.log('Artifact verification passed. This does not turn blocked browser/IME cases into passes.');
