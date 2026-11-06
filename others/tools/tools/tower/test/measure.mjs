// Measures what the design left as [추정]: cold start, first merged list, SIGTERM, idle memory, per-call overhead.
//   node test/measure.mjs [--runs 20] [--idle-s 30]
// Uses ports TOWER_TEST_PORT_BASE .. +3 on 127.0.0.1 and a temp HOME. Prints one JSON object. Writes nothing to the repository.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool, listen, open } from './regression/lib/mcp.mjs';
import { portOpen, rawRequest, waitPort } from './regression/lib/http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) : fallback);
const RUNS = arg('runs', 20);
const IDLE_S = arg('idle-s', 30);
const BASE = Number(process.env.TOWER_TEST_PORT_BASE ?? 4890);
const [GW, ALPHA] = [BASE, BASE + 1];
const NODE = process.execPath;
const UP = join(here, 'regression/upstreams');
const TOKEN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const stats = (xs) => ({ p50: Math.round(pct(xs, 0.5) * 10) / 10, p95: Math.round(pct(xs, 0.95) * 10) / 10, max: Math.round(Math.max(...xs) * 10) / 10, n: xs.length });

for (const p of [GW, ALPHA]) if (await portOpen(p, '127.0.0.1', 300)) { console.error(`port ${p} is in use`); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), 'tower-measure-'));
const dir = join(home, '.config/tower');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'token'), TOKEN, { mode: 0o600 });
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), TOWER_PORT: String(GW) };
const betaLog = join(home, 'beta.log');
const config = (upstreams) => writeFileSync(join(dir, 'tower.json'), JSON.stringify({ upstreams }));
const beta = { command: NODE, args: [join(UP, 'beta.mjs')], env: { BETA_SPAWN_LOG: betaLog }, uriPrefixes: ['beta://'] };
const alpha = { url: `http://127.0.0.1:${ALPHA}/mcp`, uriPrefixes: ['doc://alpha/'] };
const server = join(here, '../dist/server.js');
const start = () => spawn(NODE, [server], { env, stdio: 'ignore' });
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });
const upstream = spawn(NODE, [join(UP, 'alpha.mjs')], { env: { ...process.env, ALPHA_PORT: String(ALPHA) }, stdio: 'ignore', cwd: here });
await waitPort(ALPHA, 8000);
const rssOf = (pid) => { const f = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(f)?.[1] ?? 0); return { rssMb: Math.round(kb('Rss') / 102.4) / 10, pssMb: Math.round(kb('Pss') / 102.4) / 10 }; };
const out = {};

// Cold start: process start to /healthz, with no upstreams and with the two the suite uses.
for (const [label, upstreams] of [['empty', {}], ['alphaBeta', { alpha, beta }]]) {
  config(upstreams);
  const portMs = [], healthMs = [], listMs = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    const p = start();
    while (!(await portOpen(GW, '127.0.0.1', 40))) await sleep(1);
    portMs.push(performance.now() - t0);
    await rawRequest({ port: GW, path: '/healthz', timeoutMs: 2000 });
    healthMs.push(performance.now() - t0);
    const s = await open(`http://127.0.0.1:${GW}/mcp`, 'modern', TOKEN, 8000);
    await s.call('tools/list', {}, 8000);
    listMs.push(performance.now() - t0);
    await stop(p);
    await sleep(40);
  }
  out[`cold.${label}`] = { portOpen: stats(portMs), healthz: stats(healthMs), firstFullList: stats(listMs) };
}

// Everything else on one long-lived instance.
config({ alpha, beta });
const p = start();
await waitPort(GW, 5000);
const url = `http://127.0.0.1:${GW}/mcp`;
const s = await open(url, 'modern', TOKEN, 8000);
await s.call('tools/list', {}, 8000);
const lists = [], stdio = [], http = [];
for (let i = 0; i < 300; i += 1) lists.push((await s.call('tools/list')).ms);
for (let i = 0; i < 300; i += 1) stdio.push((await callTool(s, 'beta_beta_echo', { text: 'x' })).ms);
for (let i = 0; i < 300; i += 1) http.push((await callTool(s, 'alpha_status')).ms);
out.tools_list = stats(lists);
out.call_stdio = stats(stdio);
out.call_http = stats(http);
const reloadMs = [];
for (let i = 0; i < 10; i += 1) {
  const L = listen(url, s, TOKEN);
  await sleep(150);
  const t0 = performance.now();
  config({ alpha, beta: { ...beta, autoApprove: i % 2 ? [] : ['status'] } });
  while (!L.seen.some((e) => e.method === 'notifications/tools/list_changed') && performance.now() - t0 < 3000) await sleep(2);
  reloadMs.push(performance.now() - t0);
  L.close();
}
out.reloadToListChanged = stats(reloadMs);
await sleep(IDLE_S * 1000);
const status = JSON.parse((await rawRequest({ port: GW, path: '/admin/status', headers: { Authorization: `Bearer ${TOKEN}` } })).body);
out.memory = { idleS: IDLE_S, tower: rssOf(p.pid), stdioChild: rssOf(status.upstreams.beta.pid) };
const L = listen(url, s, TOKEN);
await sleep(200);
const t0 = performance.now();
await stop(p);
out.sigtermWithListenMs = Math.round(performance.now() - t0);
L.close();
upstream.kill('SIGTERM');
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
process.exit(0);
