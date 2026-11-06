// In-process HTTP servers used as proxy targets. They record what reached them, so a request that was NOT
// supposed to arrive can be detected. Both bind 127.0.0.1 only.
import { createServer } from 'node:http';
import { waitPort } from './http.mjs';

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

export async function startOrigin(port) {
  const state = { hits: [], aborted: 0, sockets: new Set() };
  const server = createServer((req, res) => {
    state.hits.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, method: req.method });
    if (req.url.startsWith('/echo')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/', 'access-control-allow-origin': '*', 'x-origin-header': 'keep' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, host: req.headers.host, added: req.headers['x-added'] ?? null }));
    }
    if (req.url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const iv = setInterval(() => { res.write(`data: ${n++}\n\n`); if (n > 5) { clearInterval(iv); res.end(); } }, 300);
      req.on('close', () => { if (n <= 5) { state.aborted += 1; clearInterval(iv); } });
      return undefined;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('origin 404');
  });
  server.on('connection', (s) => { state.sockets.add(s); s.on('close', () => state.sockets.delete(s)); });
  await listen(server, port);
  return { state, port, close: () => new Promise((r) => { for (const s of state.sockets) s.destroy(); server.close(() => r()); setTimeout(r, 500).unref(); }) };
}

// A listener that must never be reached. Any hit means the gateway followed a request to the wrong host.
export async function startTrap(port) {
  const hits = [];
  const sockets = new Set();
  const server = createServer((req, res) => { hits.push({ url: req.url, host: req.headers.host }); res.writeHead(200); res.end('TRAP'); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await listen(server, port);
  return { hits, port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); setTimeout(r, 500).unref(); }) };
}
export { waitPort };
