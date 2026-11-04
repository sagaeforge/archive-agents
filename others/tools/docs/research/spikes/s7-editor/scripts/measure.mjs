import { build } from 'vite';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { modelLoader } from './model-roundtrip.mjs';
import { writeResult } from './write-result.mjs';
import { ast, codeBlocks, readerIds, editorWikiIds } from './markdown-diagnostics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const modelOnly = process.argv.includes('--model-only');
const previousResults = modelOnly ? JSON.parse(await readFile('results.json', 'utf8')) : null;
// Keep Chromium's disposable profile and all Vite artifacts within the spike.
process.env.TMPDIR = resolve(root, '.cache');
await mkdir(process.env.TMPDIR, { recursive: true });
const browserPath = '/home/user/sagae-tools/tools/loupe/.cache/ms-playwright';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserPath;
const names = ['milkdown', 'tiptap'];
const corpus = JSON.parse(await readFile('scripts/corpus.json', 'utf8')).map(sample => ({
  ...sample, markdown: sample.markdown ?? sample.repeat.repeat(sample.count),
}));
const normalization = 'Convert CRLF or CR to LF, then remove one terminal LF. No other whitespace, punctuation, escaping, Unicode or AST normalization.';
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');

// One exact replacement hunk, with both full removed and added strings. Byte
// offsets refer to UTF-8 input; the record is sufficient to reconstruct output.
function exactDiff(before, after) {
  const a = Array.from(before), b = Array.from(after);
  let start = 0, tail = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (tail < Math.min(a.length, b.length) - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const prefix = a.slice(0, start).join('');
  const removed = a.slice(start, a.length - tail).join('');
  const added = b.slice(start, b.length - tail).join('');
  const suffix = tail ? a.slice(a.length - tail).join('') : '';
  assert.equal(prefix + added + suffix, after);
  return { format: 'exact single replacement hunk', inputByteOffset: Buffer.byteLength(prefix), removed, added };
}
const hash = text => createHash('sha256').update(text).digest('hex');

async function allFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(path)); else files.push(path);
  }
  return files;
}
async function bundle(name) {
  const outDir = resolve(root, 'dist', name);
  await build({
    configFile: false, root: resolve(root, 'src'), base: './', logLevel: 'warn',
    build: { outDir, emptyOutDir: true, sourcemap: false, minify: true,
      rollupOptions: { input: resolve(root, 'src', `${name}.html`) } },
  });
  const files = [];
  for (const path of await allFiles(outDir)) {
    const content = await readFile(path);
    files.push({ path: relative(outDir, path), rawBytes: content.length, gzipBytes: gzipSync(content, { level: 9 }).length, sha256: hash(content) });
  }
  const sum = entries => ({ rawBytes: entries.reduce((n, f) => n + f.rawBytes, 0), gzipBytes: entries.reduce((n, f) => n + f.gzipBytes, 0) });
  return { mode: 'Vite production, separate entry per candidate; same React UI, measurement API and features included',
    compression: 'Node zlib.gzipSync, level 9, each emitted file separately; sourcemaps disabled',
    total: sum(files), javascript: sum(files.filter(f => f.path.endsWith('.js'))),
    css: sum(files.filter(f => f.path.endsWith('.css'))), files,
    featureParity: ['React UI', 'CommonMark', 'GFM strike, tasks and tables', 'history/undo', 'links/images', 'composition-guarded slash/submit'],
    caveat: name === 'tiptap' ? 'Installed official table/image extensions are absent. Includes local minimal Node adapters using installed prosemirror-tables plus built-in TaskList/TaskItem. Not a measurement of the official Tiptap table extension or full table UI.' : 'Individual core, commonmark, gfm, history and clipboard packages; own React UI; no Crepe or kit. No optional block/drag/slash package UI.',
  };
}

const syllables = {
  한: ['ㅎ', '하', '한'], 글: ['ㄱ', '그', '글'], 입: ['ㅇ', '이', '입'],
  력: ['ㄹ', '려', '력'], 테: ['ㅌ', '테'], 스: ['ㅅ', '스'], 트: ['ㅌ', '트'],
};
const cases = [
  { id: 'syllable-by-syllable', seed: '', block: 0, offset: 0, expected: '한글 입력 테스트', caret: [0, 9], action: 'phrase' },
  { id: 'paragraph-start', seed: '기존 문장', block: 0, offset: 0, expected: '한기존 문장', caret: [0, 1] },
  { id: 'paragraph-middle', seed: '앞뒤', block: 0, offset: 1, expected: '앞한뒤', caret: [0, 2] },
  { id: 'paragraph-end', seed: '기존', block: 0, offset: 2, expected: '기존한', caret: [0, 3] },
  { id: 'list-item', seed: '- 항목', block: 0, offset: 2, expected: '항목한', caret: [0, 3], structure: 'list' },
  { id: 'heading', seed: '# 제목', block: 0, offset: 2, expected: '제목한', caret: [0, 3], structure: 'heading' },
  { id: 'table-cell', seed: '| 열 |\n| --- |\n| 값 |', block: 1, offset: 1, expected: '열\n값한', caret: [1, 2], structure: 'table' },
  { id: 'link-text', seed: '[링크](https://example.invalid)', block: 0, offset: 1, expected: '링한크', caret: [0, 2], structure: 'link' },
  { id: 'enter-during-composition', seed: '/메뉴 뒤', block: 0, offset: 4, expected: '/메뉴 한뒤', caret: [0, 5], action: 'enter', checkCommand: true },
  { id: 'submit-during-composition', seed: '본문 뒤', block: 0, offset: 3, expected: '본문 한뒤', caret: [0, 4], action: 'submit', checkCommand: true },
  { id: 'backspace-during-composition', seed: '앞', block: 0, offset: 1, expected: '앞하', caret: [0, 2], action: 'backspace' },
  { id: 'composition-then-undo', seed: '기존', block: 0, offset: 2, expected: '기존', caret: [0, 2], action: 'undo' },
  { id: 'fast-across-blocks', seed: '가\n\n나\n\n다', block: 0, offset: 1, expected: '가한\n나글\n다입', caret: [2, 2], action: 'fast' },
];

async function measureIme(page, errors) {
  const client = await page.context().newCDPSession(page);
  const results = [];
  let trace = [];
  async function cdp(method, params) {
    trace.push({ method, params });
    await client.send(method, params);
  }
  async function composition(text) {
    await cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  async function commit(text) { await cdp('Input.insertText', { text }); }
  async function typeSyllable(text) {
    for (const partial of syllables[text]) await composition(partial);
    await commit(text);
  }
  async function key(key, code, keyCode, modifiers = 0) {
    const params = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }
  for (const spec of cases) {
    const errorStart = errors.length;
    trace = [];
    const checkpoints = [];
    let error;
    let initial;
    try {
      await page.evaluate(seed => window.spike.reset(seed), spec.seed);
      initial = await page.evaluate(({ block, offset }) => window.spike.select(block, offset), spec);
      if (spec.action === 'phrase') {
        for (const character of '한글 입력 테스트') {
          if (character === ' ') await commit(' '); else await typeSyllable(character);
        }
      } else if (['enter', 'submit', 'backspace'].includes(spec.action)) {
        for (const partial of syllables.한) await composition(partial);
        checkpoints.push({ stage: 'before-key', snapshot: await page.evaluate(() => window.spike.snapshot()) });
        await key(spec.action === 'backspace' ? 'Backspace' : 'Enter', spec.action === 'backspace' ? 'Backspace' : 'Enter', spec.action === 'backspace' ? 8 : 13, spec.action === 'submit' ? 2 : 0);
        checkpoints.push({ stage: 'after-key-before-ime-update', snapshot: await page.evaluate(() => window.spike.snapshot()) });
        if (spec.action === 'backspace') await composition('하');
        await commit(spec.action === 'backspace' ? '하' : '한');
      } else if (spec.action === 'fast') {
        await typeSyllable('한');
        await key('ArrowDown', 'ArrowDown', 40); await key('End', 'End', 35);
        await typeSyllable('글');
        await key('ArrowDown', 'ArrowDown', 40); await key('End', 'End', 35);
        await typeSyllable('입');
      } else {
        await typeSyllable('한');
        if (spec.action === 'undo') {
          await page.waitForTimeout(50);
          checkpoints.push({ stage: 'before-undo', snapshot: await page.evaluate(() => window.spike.snapshot()) });
          await page.keyboard.press('Control+z');
        }
      }
      await page.waitForTimeout(50); // allow ProseMirror's composition-end flush
    } catch (cause) { error = String(cause.stack); }
    const snapshot = await page.evaluate(() => window.spike.snapshot());
    const delta = exactDiff(spec.expected, snapshot.text);
    const textMatch = snapshot.text === spec.expected;
    const caretMatch = snapshot.caret.blockIndex === spec.caret[0] && snapshot.caret.parentOffset === spec.caret[1] && snapshot.caret.from === snapshot.caret.to;
    const compositionEvents = snapshot.events.filter(e => e.type.startsWith('composition'));
    const genuineCompositionObserved = compositionEvents.some(e => e.type === 'compositionstart' && e.trusted)
      && compositionEvents.some(e => e.type === 'compositionend' && e.trusted)
      && compositionEvents.some(e => e.type === 'compositionupdate' && e.trusted);
    const duringEnter = snapshot.events.filter(e => e.type === 'keydown' && e.key === 'Enter');
    const commandSafe = !spec.checkCommand || (duringEnter.length > 0 && duringEnter.every(e => e.commandSuppressedByComposition) && snapshot.commands.length === 0);
    const nodes = JSON.stringify(snapshot.json);
    const structurePreserved = !spec.structure || ({
      list: () => /"(?:bullet_list|bulletList)"/.test(nodes),
      heading: () => /"heading"/.test(nodes),
      table: () => /"table"/.test(nodes) && snapshot.blocks.length === 2,
      link: () => /"link"/.test(nodes) && nodes.includes('링한크'),
    })[spec.structure]();
    const consoleErrors = errors.slice(errorStart);
    const pass = !error && textMatch && caretMatch && genuineCompositionObserved && commandSafe && structurePreserved && !consoleErrors.length;
    // Separately labelled verdict: CDP Input.insertText yields an untrusted compositionend, so `genuine` cannot pass on this path.
    // cdpSimulated = trusted compositionstart+update, compositionend present (any isTrusted), and every other check passes.
    const cdpSimulatedCompositionObserved = compositionEvents.some(e => e.type === 'compositionstart' && e.trusted)
      && compositionEvents.some(e => e.type === 'compositionupdate' && e.trusted)
      && compositionEvents.some(e => e.type === 'compositionend');
    const cdpSimulated = !error && textMatch && caretMatch && cdpSimulatedCompositionObserved && commandSafe && structurePreserved && !consoleErrors.length;
    results.push({ id: spec.id, pass, cdpSimulated, expectedText: spec.expected, finalText: snapshot.text,
      textMatch, expectedCaret: { blockIndex: spec.caret[0], parentOffset: spec.caret[1] }, caret: snapshot.caret,
      caretMatch, genuineCompositionObserved, cdpSimulatedCompositionObserved, structurePreserved, consoleErrors, error: error ?? null,
      duplicatedOrUnexpectedCharacters: delta.added, lostOrMissingCharacters: delta.removed,
      characterComparison: 'Exact prefix/suffix replacement diff; unexpected/missing strings may represent reordering rather than literal duplication/deletion.',
      enterCommand: { applicable: Boolean(spec.checkCommand), safe: commandSafe, keyEvents: duringEnter, triggered: snapshot.commands,
        scope: 'Shared app capture handler guards isComposing, keyCode 229 and view.composing; not a built-in editor slash menu.' },
      cdpTrace: trace, events: snapshot.events, initial: initial ? { text: initial.text, caret: initial.caret } : null,
      finalDocument: snapshot.json, finalMarkdown: snapshot.markdown, checkpoints,
    });
    console.log(`  IME ${spec.id}: genuine ${pass ? 'PASS' : 'FAIL'}, cdpSimulated ${cdpSimulated ? 'PASS' : 'FAIL'}${textMatch ? '' : ` text=${JSON.stringify(snapshot.text)}`}${caretMatch ? '' : ` caret=${snapshot.caret.blockIndex}:${snapshot.caret.parentOffset}`}${error ? ` ${error.split('\n')[0]}` : ''}`);
  }
  // Positive controls prove commands are wired and can execute after composition.
  const controls = [];
  for (const control of [{ seed: '/메뉴', offset: 3, modifiers: 0, command: 'slash' }, { seed: '본문', offset: 2, modifiers: 2, command: 'submit' }]) {
    await page.evaluate(seed => window.spike.reset(seed), control.seed);
    await page.evaluate(offset => window.spike.select(0, offset), control.offset);
    await key('Enter', 'Enter', 13, control.modifiers);
    const actual = await page.evaluate(() => window.spike.snapshot());
    controls.push({ expected: control.command, pass: actual.commands.some(c => c.command === control.command), commands: actual.commands });
  }
  await client.detach();
  return { protocol: 'Real trusted browser composition events via CDP Input.imeSetComposition (intermediate jamo) and Input.insertText (commit). CDP Input.dispatchKeyEvent for special keys. No JS-dispatched CompositionEvent.',
    backspaceSemantics: 'Send Backspace during active 한 preedit, then explicitly model IME update to 하 and commit 하. CDP does not implement Windows jamo deletion logic; the after-key checkpoint captures browser default effects separately.',
    fastSemantics: 'No per-stroke delays: commit 한, real ArrowDown/End, commit 글, real ArrowDown/End, commit 입 across three existing paragraphs.',
    pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length,
    cdpSimulatedPass: results.filter(r => r.cdpSimulated).length, cdpSimulatedFail: results.filter(r => !r.cdpSimulated).length,
    cdpSimulatedMeaning: 'Trusted compositionstart+compositionupdate, compositionend observed with any isTrusted, and text/caret/structure/console/Enter-guard checks pass. Not proof of real Windows Korean IME behaviour.',
    total: results.length, commandPositiveControls: controls, cases: results };
}

async function roundtrip(load, errors) {
  const samples = [];
  for (const sample of corpus) {
    const errorStart = errors.length;
    let output = null, snapshot, error;
    try {
      snapshot = await load(sample.markdown);
      output = snapshot.markdown;
    } catch (cause) { error = String(cause.stack); }
    const identical = output !== null && Buffer.from(sample.markdown).equals(Buffer.from(output));
    const normalizedEqual = output !== null && normalize(sample.markdown) === normalize(output);
    const classification = identical ? 'identical' : normalizedEqual ? 'normalized-only' : 'failed';
    const literalTextPreserved = sample.mustContainText ? Boolean(snapshot?.text.includes(sample.mustContainText)) : null;
    const inputIds = await readerIds(sample.markdown);
    const outputIds = output === null ? null : await readerIds(output);
    const nodeIds = snapshot?.json ? editorWikiIds(snapshot.json) : null;
    samples.push({ id: sample.id, classification, identical, normalizedEqual,
      input: sample.markdown, output, inputBytes: Buffer.byteLength(sample.markdown), outputBytes: output === null ? null : Buffer.byteLength(output),
      inputSha256: hash(sample.markdown), outputSha256: output === null ? null : hash(output),
      diff: identical || output === null ? null : exactDiff(sample.markdown, output),
      astEqualDiagnosticOnly: output !== null && ast(sample.markdown) === ast(output),
      wikiLinks: { inputIds, outputIds, nodeIds,
        readerIdsPreserved: JSON.stringify(inputIds) === JSON.stringify(outputIds),
        nodeIdsMatchReader: JSON.stringify(inputIds) === JSON.stringify(nodeIds) },
      codeBlocks: { input: codeBlocks(sample.markdown), output: output === null ? null : codeBlocks(output),
        preserved: output !== null && JSON.stringify(codeBlocks(sample.markdown)) === JSON.stringify(codeBlocks(output)) },
      mustContainText: sample.mustContainText ?? null, literalTextPreserved,
      renderedText: snapshot?.text ?? null,
      htmlLookingTextRenderedAsMarkup: sample.mustContainText ? snapshot?.htmlLookingTextRenderedAsMarkup ?? null : null,
      wikiTokensPreservedVerbatim: sample.id.startsWith('wiki-') || sample.id === 'long-line'
        ? [...sample.markdown.matchAll(/\[\[[^\]\n]+\]\]/g)].every(([token]) => output?.includes(token)) : null,
      consoleErrors: errors.slice(errorStart), error: error ?? null });
  }
  const counts = { identical: 0, normalizedOnly: 0, failed: 0 };
  for (const sample of samples) counts[sample.classification === 'normalized-only' ? 'normalizedOnly' : sample.classification]++;
  console.log(`  roundtrip: ${JSON.stringify(counts)}`);
  return { total: samples.length, ...counts, normalizedEqualIncludingIdentical: counts.identical + counts.normalizedOnly,
    originalCorpus: { total: 36, ...Object.fromEntries(['identical', 'normalizedOnly', 'failed'].map(key => [key,
      samples.slice(0, 36).filter(s => s.classification === ({ normalizedOnly: 'normalized-only' }[key] ?? key)).length])) },
    structureChanged: samples.filter(s => !s.astEqualDiagnosticOnly).length,
    normalization, failedMeaning: 'Any byte change beyond the stated newline normalization, or load/serialization error. Formatting-only changes count as failures too. AST equality is auxiliary only and never counted as identical or normalized.',
    literalTextFailures: samples.filter(s => s.literalTextPreserved === false).map(s => s.id), samples };
}

const results = {
  metadata: {
    generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform,
    versions: Object.fromEntries(await Promise.all(['@milkdown/core', '@milkdown/preset-commonmark', '@milkdown/preset-gfm', '@tiptap/core', '@tiptap/markdown', 'react', 'vite', 'playwright'].map(async name => [name, JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version]))),
    network: 'No network or installation. Playwright fulfills http://spike.invalid/* directly from local production build files; all other HTTP(S) requests are aborted. No listening server or HTTP connection.',
    corpus: 'scripts/corpus.json', corpusSha256: hash(await readFile('scripts/corpus.json')),
    limitations: [
      'CDP preedit simulates Chromium composition plumbing, not the real Windows Korean IME/TSF, 2-beolsik key-to-jamo conversion, candidate window, reconversion, OS/browser keyboard event ordering, or hardware/layout behavior.',
      'Enter/Backspace are injected DOM key paths; IME consumption and keyCode 229 can differ on Windows. Backspace uses an explicit modeled preedit update. Success is not proof of Windows IME reliability.',
      'The slash/submit check covers the common guarded app handler only. A future menu/plugin or app key handler requires separate checks.',
      'Tiptap uses local minimal table/image adapters because official packages are not installed; their serializer results and bundle bytes must not be attributed solely to upstream Tiptap.',
      'Headless Chromium/Linux only; real Windows Chrome/Edge Korean Microsoft IME manual checks remain mandatory before choosing on IME grounds.',
    ],
    manualCheck: ['Windows 11 Microsoft Korean IME (2-beolsik), Chrome and Edge: repeat every case using physical keys; observe final text and caret.', 'Specifically check Enter commits without slash/submit, Ctrl+Enter while preediting, jamo Backspace, undo after commit, and rapid Enter/Arrow navigation across blocks.', 'Test candidate selection/reconversion, focus loss/regain and paste with actual IME; record OS/browser/IME versions and screen capture.'],
  },
};
for (const name of names) {
  console.log(`Building ${name}...`);
  results[name] = { bundle: await bundle(name) };
}

let browser;
try {
  let blocker;
  if (modelOnly) {
    blocker = { status: 'skipped', reason: '--model-only: retained existing IME data; no browser launch attempted' };
  } else {
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-default-browser-check'] });
    } catch (error) {
      blocker = { status: 'blocked', error: String(error), attemptCountThisRun: 1 };
    }
  }
  results.metadata.browser = browser?.version() ?? null;
  results.metadata.browserExecution = browser ? { status: 'measured' } : blocker;
  for (const name of names) {
    console.log(`Measuring ${name}...`);
    if (!browser) {
      results[name].ime = previousResults?.[name]?.ime ?? {
        status: 'blocked', measured: false, pass: 0, fail: 0, notRun: cases.length, total: cases.length,
        reason: blocker,
        cases: cases.map(spec => ({ id: spec.id, status: 'not-run', pass: null, expectedText: spec.expected,
          finalText: null, duplicatedOrUnexpectedCharacters: null, lostOrMissingCharacters: null,
          caret: null, consoleErrors: null, enterCommand: null })),
      };
      results[name].roundtrip = await roundtrip(await modelLoader(name), []);
      results[name].roundtrip.execution = 'Node: actual editor parser -> ProseMirror document (doc.check) -> actual serializer. No browser EditorView. Tiptap HTML tokens use inert literal nodes in both runtimes; DOM behavior is unmeasured.';
      results[name].roundtrip.browserVerified = false;
      results[name].roundtrip.browserHtmlUnverified = corpus.filter(s => s.mustContainText).map(s => s.id);
      await writeFile('results.json', JSON.stringify(results, null, 2) + '\n');
      continue;
    }
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const blocked = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'spike.invalid') { blocked.push(url.origin); return route.abort(); }
      const path = resolve(root, 'dist', `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(resolve(root, 'dist') + '/')) return route.abort();
      try {
        await route.fulfill({ body: await readFile(path), contentType: ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream' });
      } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', text: message.text() }); });
    page.on('pageerror', error => errors.push({ type: 'pageerror', text: String(error.stack) }));
    await page.goto(`http://spike.invalid/${name}/${name}.html`);
    await page.waitForFunction(() => window.spike?.ready || window.spike?.error);
    const initError = await page.evaluate(() => window.spike.error);
    if (initError) throw new Error(initError);
    results[name].ime = await measureIme(page, errors);
    results[name].ime.status = 'measured';
    results[name].ime.measured = true;
    results[name].ime.notRun = 0;
    results[name].roundtrip = await roundtrip(async markdown => {
      const snapshot = await page.evaluate(markdown => window.spike.reset(markdown), markdown);
      snapshot.htmlLookingTextRenderedAsMarkup = Boolean(await page.locator('.ProseMirror em, .ProseMirror script, .ProseMirror div[data-note]').count());
      return snapshot;
    }, errors);
    results[name].roundtrip.execution = 'Production browser app: reset editor with Markdown -> ProseMirror document -> editor serializer.';
    results[name].roundtrip.browserVerified = true;
    results[name].initializationAndAllConsoleErrors = errors;
    results[name].blockedExternalRequests = blocked;
    await context.close();
    await writeFile('results.json', JSON.stringify(results, null, 2) + '\n');
  }
} finally {
  await browser?.close();
}
if (modelOnly) {
  results.metadata.imeRetainedFrom = previousResults.metadata.imeRetainedFrom ?? {
    generatedAt: previousResults.metadata.generatedAt, browser: previousResults.metadata.browser,
  };
  for (const name of names) assert.deepEqual(results[name].ime, previousResults[name].ime);
}
await writeFile('results.json', JSON.stringify(results, null, 2) + '\n');
await writeResult(results);
console.log('Wrote results.json');
if (!browser && !process.argv.includes('--model-only')) {
  console.error('INCOMPLETE: Chromium could not launch; IME was NOT measured. Model roundtrip and bundle results are saved.');
  process.exitCode = 2;
}
