// Static server for dist plus result collector. Binds 127.0.0.1.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const root = new URL('.', import.meta.url).pathname; const dist = join(root, 'dist'); const port = +process.argv[2]; const tag = process.argv[3] || 'x';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const plans = new Map();
createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const f = u.pathname === '/result' ? `out/results-${tag}.jsonl` : `out/log-${tag}.jsonl`; appendFileSync(join(root, f), b + '\n'); res.end('ok'); }); return; }
  if (u.pathname === '/next') { const run = u.searchParams.get('run'); let p = plans.get(run); if (!p) { const f = join(root, `out/plan-${run}.json`); p = { list: JSON.parse(readFileSync(f)), i: 0 }; plans.set(run, p); } const q = p.list[p.i++]; writeFileSync(join(root, `out/progress-${run}.txt`), `${p.i}/${p.list.length} ${q ?? 'done'}\n`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(q ? { q } : { done: true })); return; }
  let f = normalize(join(dist, u.pathname === '/' ? 'index.html' : u.pathname)); if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('content-type', mime[extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(readFileSync(f));
}).listen(port, '127.0.0.1', () => console.log('up', port));
