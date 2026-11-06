// Does a per-connection timeout bound a hanging closed loopback port, through the real SDK client transport?
const [undiciPath, sdkClient] = process.argv.slice(2);
const { Agent, fetch: uFetch } = await import(undiciPath);
const { Client, StreamableHTTPClientTransport } = await import(sdkClient);
const PORT = 18977, url = `http://127.0.0.1:${PORT}/mcp`;
const t = async (label, fn) => { const s = performance.now(); let r; try { r = await fn(); r = 'ok ' + (r?.status ?? ''); } catch (e) { r = `${e.name}:${e.cause?.code ?? e.code ?? ''}:${String(e.cause?.message ?? e.message).slice(0, 70)}`; } console.log(JSON.stringify({ label, ms: Math.round(performance.now() - s), r })); };
const agent = new Agent({ connect: { timeout: 1000 }, headersTimeout: 0, bodyTimeout: 0 });
const f = (i, init) => uFetch(i, { ...init, dispatcher: agent });
await t('global fetch default', () => fetch(url, { method: 'POST', body: '{}' }));
await t('undici fetch, Agent connect 1s', () => f(url, { method: 'POST', body: '{}' }));
await t('global fetch + npm Agent', () => fetch(url, { method: 'POST', body: '{}', dispatcher: agent }));
for (const [label, opts] of [['SDK connect, auto, custom fetch', { fetch: f }], ['SDK connect, auto, default fetch', {}]]) {
  const c = new Client({ name: 'p', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await t(label, () => c.connect(new StreamableHTTPClientTransport(new URL(url), opts), { timeout: 15000 }));
  await c.close().catch(() => {});
}
process.exit(0);
