// Relay behaviour through a gateway, driven by the official SDK client pinned to 2026-07-28.
// usage: _relay.mjs <url> <bearer|-> <short|long> <eventsFile>
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { connectFetch } from '../lib/http.mjs'; // closed loopback ports hang on this host: every connection needs a connect timeout

const [url, bearer, mode, events] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Client({ name: 'relay', version: '0.0.1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
const headers = bearer === '-' ? {} : { authorization: `Bearer ${bearer}` };
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: connectFetch }));
const { tools } = await client.listTools();
const slow = tools.find((t) => /slow$/.test(t.name))?.name;
if (!slow) { console.log('no slow tool', tools.map((t) => t.name).join(',')); process.exit(0); }

if (mode === 'long') {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name: slow, arguments: { ms: 70000 } }, { timeout: 110000 });
    console.log(`70 s call: ok after ${Date.now() - t0} ms: ${r.content?.[0]?.text?.slice(0, 60)} isError=${r.isError ?? false}`);
  } catch (e) {
    console.log(`70 s call: FAILED after ${Date.now() - t0} ms: ${String(e.message).slice(0, 110)}`);
  }
  process.exit(0);
}

let progress = 0;
await client.callTool({ name: slow, arguments: { ms: 2500 } }, { onprogress: () => { progress += 1; }, timeout: 20000 }).catch((e) => console.log('progress call error', e.message.slice(0, 100)));
console.log(`progress notifications received: ${progress} (upstream sends about 5)`);

const before = readFileSync(events, 'utf8').split('\n').filter(Boolean).length;
const ac = new AbortController();
setTimeout(() => ac.abort(), 1000);
const t0 = Date.now();
await client.callTool({ name: slow, arguments: { ms: 8000 } }, { signal: ac.signal, timeout: 20000 }).catch(() => {});
const clientSaw = Date.now() - t0;
await sleep(1500);
const seen = readFileSync(events, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
console.log(`cancel: client returned after ${clientSaw} ms; upstream saw cancel=${seen.some((e) => e.ev === 'cancelled')} stopped=${seen.some((e) => e.ev === 'stopped')} ${JSON.stringify(seen).slice(0, 100)}`);

const { resources } = await client.listResources();
const ko = resources.find((r) => /스냅샷|%EC%8A%A4|%25EC/i.test(r.uri));
if (ko) {
  try {
    const r = await client.readResource({ uri: ko.uri });
    console.log(`korean uri: listed ${ko.uri} read ok, body=${r.contents?.[0]?.text}`);
  } catch (e) {
    console.log(`korean uri: listed ${ko.uri} read FAILED ${String(e.message).slice(0, 120)}`);
  }
} else console.log(`korean uri: not listed (${resources.map((r) => r.uri).join(', ')})`);
process.exit(0);
