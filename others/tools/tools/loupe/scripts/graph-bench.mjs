#!/usr/bin/env node
// The manual graph bench (design 11). Builds the bench page, makes the synthetic data once under .cache/bench, serves both on 127.0.0.1 and
// appends each result to .cache/bench/results.jsonl. It opens no window: a person opens the printed URL in a focused Chrome window on the GPU under test.
//   node scripts/graph-bench.mjs [port]        default port 4836
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchResult } from './lib/bench-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache/bench'), dist = path.join(cache, 'dist'), dataDir = path.join(cache, 'data');
const port = Number(process.argv[2] ?? process.env.LOUPE_BENCH_PORT ?? 4836);
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');

mkdirSync(dataDir, { recursive: true });
execFileSync(process.execPath, [viteBin, 'build', '--config', 'bench/vite.config.ts', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
const { buildBenchGraph, SIZES } = await import('../bench/data.ts');
for (const [name, s] of Object.entries(SIZES)) {
  const f = path.join(dataDir, `${name}.json`);
  if (existsSync(f)) continue;
  console.log(`making ${name}: ${s.nodes} nodes, ${s.edges} edges, with a real layout (about ${Math.round(s.nodes / 900)} s)`);
  writeFileSync(f, JSON.stringify(buildBenchGraph(s.nodes, s.edges)));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const results = path.join(cache, 'results.jsonl');
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = parseBenchResult(body);
      if (!parsed.ok) { res.statusCode = 400; res.end(parsed.reason); return; }
      appendFileSync(results, `${body}\n`);
      console.log(parsed.line);
      res.end('ok');
    });
    return;
  }
  const clean = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const file = clean.startsWith('/data/') ? path.join(dataDir, path.basename(clean)) : path.join(dist, clean === '/' ? 'index.html' : clean);
  if (!file.startsWith(cache) || !existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.end(readFileSync(file));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`bench on http://127.0.0.1:${port}/?size=10k&label=rtx  results in ${results}`);
});
