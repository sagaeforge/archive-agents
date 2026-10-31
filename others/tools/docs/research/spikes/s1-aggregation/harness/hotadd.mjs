// Does a new upstream appear without a client change or a gateway restart?
// usage: hotadd.mjs <url> <legacy|modern> <bearer|-> <reload-shell-command>
// A gamma upstream must already be running; the command makes the gateway aware of it.
import { execSync } from 'node:child_process';
import { MODERN, open, outcome } from './lib.mjs';

const [url, era, bearerArg, cmd] = process.argv.slice(2);
const bearer = bearerArg === '-' ? undefined : bearerArg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = await open(url, era, bearer);
const names = (r) => r.json?.result?.tools?.map((t) => t.name) ?? [];
const before = await s.call('tools/list');
console.log(`before: ${outcome(before)}`);

// Listen for server notifications: GET stream in the legacy era, subscriptions/listen in the modern one.
const seen = [];
const ac = new AbortController();
const headers = { accept: 'text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
let streamInfo = 'none';
(async () => {
  try {
    let res;
    if (era === 'legacy') {
      res = await fetch(url, { headers: { ...headers, 'mcp-protocol-version': s.negotiated, ...(s.session ? { 'mcp-session-id': s.session } : {}) }, signal: ac.signal });
    } else {
      const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'hot', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'subscriptions/listen' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true, resourcesListChanged: true }, _meta: meta } }),
        signal: ac.signal,
      });
    }
    streamInfo = `http=${res.status} ct=${res.headers.get('content-type')}`;
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      for (const l of dec.decode(value).split(/\r?\n/)) {
        if (l.startsWith('data:') && l.length > 6) { try { seen.push(JSON.parse(l.slice(5).trim()).method ?? 'response'); } catch { seen.push('unparsed'); } }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') streamInfo += ` err=${e.message}`;
  }
})();
await sleep(500);

console.log(`reload: ${cmd}`);
const t0 = performance.now();
execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
let appeared = null;
for (let i = 0; i < 80; i++) {
  const r = await s.call('tools/list');
  if (names(r).some((n) => /_g$/.test(n))) { appeared = performance.now() - t0; break; }
  await sleep(100);
}
console.log(`same session sees new upstream: ${appeared === null ? 'NO after 8 s' : `yes after ${appeared.toFixed(0)} ms`}`);
const after = await s.call('tools/list');
console.log(`same session tools: ${outcome(after)}`);
const n = await open(url, era, bearer);
const nl = await n.call('tools/list');
console.log(`new session tools:  ${outcome(nl)}`);
const g = names(nl).find((x) => /status_g$/.test(x));
if (g) console.log(`new session call ${g}: ${outcome(await n.call('tools/call', { name: g, arguments: {} }))}`);
const g2 = names(after).find((x) => /status_g$/.test(x));
if (g2) console.log(`same session call ${g2}: ${outcome(await s.call('tools/call', { name: g2, arguments: {} }))}`);
await sleep(3000);
ac.abort();
console.log(`notification stream: ${streamInfo}`);
console.log(`notifications seen: ${seen.length ? seen.join(' | ') : 'none'}`);
process.exit(0);
