// HTTP and socket helpers. A closed loopback port HANGS on this host instead of refusing,
// so every connection in the suite carries a connect timeout.
import net from 'node:net';
import { Agent, fetch as ufetch } from 'undici';
import { sleep } from './util.mjs';

export const CONNECT_TIMEOUT_MS = 1000;
export const agent = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS }, headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 100, keepAliveMaxTimeout: 100 });
// Pass as the `fetch` option of an SDK transport, or call directly.
export const connectFetch = (url, init = {}) => ufetch(url, { ...init, dispatcher: agent });

// One TCP connect attempt with a hard cap. Resolves true when the port accepts.
export function portOpen(port, host = '127.0.0.1', timeoutMs = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function waitPort(port, timeoutMs = 10000, host = '127.0.0.1') {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (await portOpen(port, host, 250)) return true;
    await sleep(10);
  }
  return false;
}

// Raw HTTP/1.1 over a socket: nothing normalises the request line, so `..%2f`, `//host` and odd Host headers arrive as written.
// `lines` is an array of header lines (no CRLF); the request line is `${method} ${path} HTTP/1.1`.
export function rawRequest({ port, method = 'GET', path, headers = {}, body, host = `127.0.0.1:${port}`, timeoutMs = 8000, readMs = 1500 }) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const h = { Host: host, Connection: 'close', ...headers };
    if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    const chunks = [];
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (extra = {}) => {
      if (settled) return; settled = true; clearTimeout(cap); clearTimeout(connectTimer); s.destroy();
      const raw = Buffer.concat(chunks).toString('latin1');
      const i = raw.indexOf('\r\n\r\n');
      const headText = i >= 0 ? raw.slice(0, i) : raw;
      const lines = headText.split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const hdrs = {};
      for (const l of lines.slice(1)) { const j = l.indexOf(':'); if (j > 0) (hdrs[l.slice(0, j).toLowerCase()] ??= []).push(l.slice(j + 1).trim()); }
      let bodyBuf = i >= 0 ? Buffer.from(raw.slice(i + 4), 'latin1') : Buffer.alloc(0);
      if (/chunked/i.test(hdrs['transfer-encoding']?.[0] ?? '')) bodyBuf = dechunk(bodyBuf);
      resolve({ status, headers: hdrs, body: bodyBuf.toString('utf8'), ms: Math.round(performance.now() - t0), ...extra });
    };
    const cap = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    const connectTimer = setTimeout(() => finish({ connectTimeout: true }), CONNECT_TIMEOUT_MS);
    s.once('connect', () => { clearTimeout(connectTimer); s.write(head + (body ?? '')); });
    let idle;
    s.on('data', (d) => { chunks.push(d); clearTimeout(idle); idle = setTimeout(() => finish(), readMs); });
    s.once('end', () => finish());
    s.once('close', () => finish());
    s.once('error', (e) => finish({ error: e.code ?? e.message }));
  });
}

function dechunk(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) break;
    const size = parseInt(buf.slice(pos, eol).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.slice(eol + 2, eol + 2 + size));
    pos = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export const jsonBody = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
