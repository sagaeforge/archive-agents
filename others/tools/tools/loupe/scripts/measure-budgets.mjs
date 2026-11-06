// Measures the section 11 rows that apply to Phase 1 against kb-mock, with and without loupe serve in the path.
// Latency here says nothing about the real KB: the budget rows say "실제 KB에서만 판정". It shows what the viewer and the proxy add.
// Usage: node scripts/measure-budgets.mjs [--rounds=300]   Ports: 4830. Socket: $LOUPE_SOCKET_DIR.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rounds = Number(process.argv.find((a) => a.startsWith('--rounds='))?.split('=')[1] ?? 300);
const sockDir = process.env.LOUPE_SOCKET_DIR ?? path.join(root, '.cache/sock');
mkdirSync(sockDir, { recursive: true });
const sock = path.join(sockDir, 'm.s');
rmSync(sock, { force: true });

const start = (args, env) => spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
const mock = start(['dev/kb-mock/main.ts'], { KB_FIXTURES: 'contract-sample/fixtures/kb-research.json', KB_MOCK_SOCKET: sock });
const serve = start(['bin/loupe.mjs', 'serve'], { KB_URL: `unix:${sock}`, LOUPE_PORT: '4830' });
const wait = async (f) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
const get = (opts) => new Promise((res, rej) => {
  const t0 = performance.now();
  const r = http.get(opts, (m) => { let n = 0; m.on('data', (d) => { n += d.length; }); m.on('end', () => res({ ms: performance.now() - t0, status: m.statusCode, bytes: n })); });
  r.on('error', rej);
});
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const round = (x) => Math.round(x * 100) / 100;

const ops = {
  detail: '/v1/nodes/e%3Alibrary%3Asigma-js?include=claims%2Cedges%2Cbacklinks%2Cbody&claim_limit=50&edge_limit=200',
  neighbors: '/v1/nodes/e%3Alibrary%3Asigma-js/neighbors?depth=1&direction=both&limit=200',
  search: '/v1/search?q=mcp&kinds=entity%2Crecord&limit=12',
  'as-of detail': '/v1/nodes/e%3Alibrary%3Asigma-js?include=claims%2Cedges%2Cbacklinks%2Cbody&claim_limit=50&edge_limit=200&as_of_valid=2026-10-28T00%3A00%3A00Z&as_of_observed=2026-10-31T12%3A00%3A00Z',
  'text window': '/v1/snapshots/n-b0b5bb5257562d33/text?start=18000&max_chars=20000',
  meta: '/v1/meta',
};

const out = { rounds, latency: {}, bundle: {} };
try {
  await wait(() => existsSync(sock));
  await wait(() => get({ host: '127.0.0.1', port: 4830, path: '/healthz', timeout: 300 }).then((r) => r.status === 200, () => false));
  for (const [name, path_] of Object.entries(ops)) {
    const direct = [], proxied = [];
    let status = 0, bytes = 0;
    for (let i = 0; i < 20; i++) { await get({ socketPath: sock, path: path_ }); await get({ host: '127.0.0.1', port: 4830, path: `/kb${path_}` }); }
    for (let i = 0; i < rounds; i++) {
      direct.push((await get({ socketPath: sock, path: path_ })).ms);
      const r = await get({ host: '127.0.0.1', port: 4830, path: `/kb${path_}` });
      proxied.push(r.ms); status = r.status; bytes = r.bytes;
    }
    out.latency[name] = {
      status, bytes,
      direct_p50: round(pct(direct, 0.5)), direct_p95: round(pct(direct, 0.95)), proxied_p50: round(pct(proxied, 0.5)), proxied_p95: round(pct(proxied, 0.95)),
      proxy_overhead_p50: round(pct(proxied, 0.5) - pct(direct, 0.5)), proxy_overhead_p95: round(pct(proxied, 0.95) - pct(direct, 0.95)),
    };
  }
} finally {
  mock.kill('SIGTERM'); serve.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(sock, { force: true });
}

const assets = path.join(root, 'dist/assets');
if (existsSync(assets)) {
  const rows = readdirSync(assets).map((f) => { const b = readFileSync(path.join(assets, f)); return { f, kb: round(b.length / 1024), gz: round(gzipSync(b).length / 1024) }; });
  const of = (re) => rows.filter((r) => re.test(r.f));
  out.bundle = {
    initial_js: of(/^index-.*\.js$/), css: of(/\.css$/), markdown_view: of(/^MarkdownView/), worker: of(/worker/),
    language_chunks: { count: rows.length - of(/^index-|\.css$|^MarkdownView|worker/).length, kb: round(rows.filter((r) => !/^index-|\.css$|^MarkdownView|worker/.test(r.f)).reduce((n, r) => n + r.kb, 0)) },
  };
}
console.log(JSON.stringify(out, null, 1));
