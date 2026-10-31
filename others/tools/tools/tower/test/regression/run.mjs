// Regression runner: one unattended command, one row per section 10 scenario.
//   npm run test:regression -w tools/tower
// Environment:
//   TOWER_TEST_TARGET     tower (default) | spike, the S1 baseline the suite started from
//   TOWER_TEST_SERVER     another build's server.js, to show a check fails without its fix
//   TOWER_TEST_PORT_BASE  first of 10 reserved loopback ports, default 4890
//   TOWER_TEST_ONLY       comma list of scenario ids or row numbers to run
//   TOWER_TEST_SKIP       comma list to leave out
//   TOWER_TEST_LIST=1     print the scenario list and exit
//   TOWER_TEST_TMP        scratch root (default tools/tower/test/regression/.run)
//   TOWER_TEST_KEEP=1     keep each scenario's temp dir
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT_BASE, PORT_RANGE, RUN_DIR } from './harness/env.mjs';
import { makeCtx } from './lib/ctx.mjs';
import { portOpen } from './lib/http.mjs';
import { killAllSync } from './lib/proc.mjs';
import { REGRESSION, TARGET, targetReady } from './lib/target.mjs';
import { short, sleep, withTimeout } from './lib/util.mjs';

const only = (process.env.TOWER_TEST_ONLY ?? '').split(',').filter(Boolean);
const skip = (process.env.TOWER_TEST_SKIP ?? '').split(',').filter(Boolean);
const scale = Number(process.env.TOWER_TEST_TIMEOUT_SCALE ?? 1);

const all = [];
for (const f of readdirSync(join(REGRESSION, 'scenarios')).filter((n) => n.endsWith('.mjs')).sort()) {
  const m = await import(pathToFileURL(join(REGRESSION, 'scenarios', f)).href);
  all.push(...m.scenarios);
}
all.sort((a, b) => a.order - b.order);
const wanted = all.filter((s) => (!only.length || only.includes(s.id) || only.includes(String(s.row))) && !skip.includes(s.id) && !skip.includes(String(s.row)));

if (process.env.TOWER_TEST_LIST) {
  for (const s of all) console.log(`${String(s.row).padStart(2)}  ${s.id.padEnd(18)} timeout ${s.timeoutMs / 1000}s  ${s.title}`);
  process.exit(0);
}

const notReady = targetReady();
if (notReady) { console.error(`TOWER_TEST_TARGET=${TARGET}: ${notReady}`); process.exit(2); }
const busy = [];
await Promise.all(Array.from({ length: PORT_RANGE }, (_, i) => PORT_BASE + i).map(async (p) => { if (await portOpen(p, '127.0.0.1', 400)) busy.push(p); }));
if (busy.length) { console.error(`reserved test ports in use: ${busy.join(', ')} (TOWER_TEST_PORT_BASE=${PORT_BASE}, range ${PORT_RANGE})`); process.exit(2); }

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAllSync(); process.exit(130); });
console.log(`tower regression  target=${TARGET}  ports=${PORT_BASE}..${PORT_BASE + PORT_RANGE - 1}  scenarios=${wanted.length}/${all.length}`);
console.log('row  id                 result  spike-doc   secs  note');

const results = [];
for (const s of wanted) {
  const ctx = makeCtx(s.id);
  const t0 = performance.now();
  let outcome = 'PASS';
  let error = null;
  try {
    await withTimeout(s.run(ctx), s.timeoutMs * scale, `scenario ${s.id}`);
    if (ctx.checks.length === 0) outcome = 'ERROR', error = 'scenario made no checks';
    else if (ctx.checks.some((c) => !c.ok)) outcome = 'FAIL';
  } catch (e) {
    outcome = e.timeout ? 'TIMEOUT' : 'ERROR';
    error = short(e?.stack?.split('\n').slice(0, 2).join(' ') ?? e, 200);
  }
  const secs = (performance.now() - t0) / 1000;
  await ctx.cleanup();
  await sleep(150);
  const failing = ctx.checks.filter((c) => !c.ok);
  const doc = TARGET === 'spike' ? (ctx.doc?.match === true ? 'match' : ctx.doc?.match === false ? 'MISMATCH' : ctx.doc ? 'n/a' : 'n/a') : '-';
  const note = error ?? (failing.length ? `${failing[0].name}${failing[0].detail ? ` (${failing[0].detail})` : ''}${failing.length > 1 ? ` +${failing.length - 1} more` : ''}` : `${ctx.checks.length} checks`);
  console.log(`${String(s.row).padStart(2)}   ${s.id.padEnd(18)} ${outcome.padEnd(7)} ${doc.padEnd(10)} ${secs.toFixed(1).padStart(5)}  ${short(note, 110)}`);
  results.push({ row: s.row, id: s.id, title: s.title, outcome, secs: +secs.toFixed(1), error, checks: ctx.checks, metrics: ctx.metrics, doc: ctx.doc });
}

killAllSync();
const resultsDir = join(REGRESSION, 'results');
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, `latest-${TARGET}.json`), JSON.stringify({ target: TARGET, at: new Date().toISOString(), portBase: PORT_BASE, results }, null, 1));
if (!process.env.TOWER_TEST_KEEP) { try { rmdirSync(RUN_DIR); } catch {} } // only removes an empty directory

const leftovers = [];
await Promise.all(Array.from({ length: PORT_RANGE }, (_, i) => PORT_BASE + i).map(async (p) => { if (await portOpen(p, '127.0.0.1', 400)) leftovers.push(p); }));
const count = (o) => results.filter((r) => r.outcome === o).length;
console.log(`summary  PASS ${count('PASS')}  FAIL ${count('FAIL')}  ERROR ${count('ERROR')}  TIMEOUT ${count('TIMEOUT')}  of ${results.length}`
  + (TARGET === 'spike' ? `   spike-doc: match ${results.filter((r) => r.doc?.match === true).length}, MISMATCH ${results.filter((r) => r.doc?.match === false).length}, n/a ${results.filter((r) => !r.doc || r.doc.match === null).length}` : '')
  + `   listeners left on test ports: ${leftovers.length ? leftovers.join(',') : 'none'}`);
console.log(`details: ${join(resultsDir, `latest-${TARGET}.json`)}`);
process.exit(results.every((r) => r.outcome === 'PASS') && !leftovers.length ? 0 : 1);
