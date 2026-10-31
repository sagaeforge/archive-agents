// Raw JSON-RPC probe. Era is chosen by the caller, nothing is hidden by an SDK.
// usage: node probe.mjs <url> <legacy|modern|both> [--out file] [--bearer tok]
// Prints a compact summary and writes the full transcript to --out.
import { writeFileSync } from 'node:fs';
import { connectFetch } from '../lib/http.mjs'; // connect timeout, see lib/http.mjs

const [url, era = 'both', ...rest] = process.argv.slice(2);
const argv = Object.fromEntries(rest.map((v, i) => (v.startsWith('--') ? [v.slice(2), rest[i + 1]] : null)).filter(Boolean));
const MODERN = '2026-07-28';
const LEGACY = argv.legacyVersion ?? '2025-11-25';
const clientInfo = { name: 's1-probe', version: '0.0.1' };
let id = 0;

async function post(body, headers = {}) {
  const t0 = performance.now();
  const auth = argv.bearer ? { authorization: `Bearer ${argv.bearer}` } : {};
  const res = await connectFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(argv.timeout ?? 15000)),
  });
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let json = null;
  if (ct.includes('text/event-stream')) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    for (const d of datas) {
      try {
        const o = JSON.parse(d);
        if ('result' in o || 'error' in o) json = o;
      } catch {}
    }
  } else if (text) {
    try { json = JSON.parse(text); } catch {}
  }
  return { status: res.status, ct, session: res.headers.get('mcp-session-id'), json, raw: json ? undefined : text.slice(0, 400), ms: +(performance.now() - t0).toFixed(1) };
}

function brief(r) {
  if (!r) return r;
  if (r.json?.error) return { status: r.status, error: r.json.error };
  if (!r.json) return { status: r.status, raw: r.raw };
  return { status: r.status, ok: true };
}

async function legacySession() {
  const t = { era: 'legacy', steps: {} };
  const init = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo } });
  t.steps.initialize = init;
  const session = init.session;
  const h = { 'mcp-protocol-version': init.json?.result?.protocolVersion ?? LEGACY, ...(session ? { 'mcp-session-id': session } : {}) };
  t.session = session;
  t.negotiated = init.json?.result?.protocolVersion ?? null;
  t.serverInfo = init.json?.result?.serverInfo;
  t.instructions = init.json?.result?.instructions;
  t.capabilities = init.json?.result?.capabilities;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, h);
  const call = (method, params = {}) => post({ jsonrpc: '2.0', id: ++id, method, params }, h);
  t.call = call;
  return t;
}

async function modernSession() {
  const t = { era: 'modern', steps: {} };
  const meta = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const disc = await post(
    { jsonrpc: '2.0', id: ++id, method: 'server/discover', params: { _meta: meta } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
  );
  t.steps.discover = disc;
  const r = disc.json?.result;
  t.negotiated = r ? (r.supportedVersions?.includes(MODERN) ? MODERN : `supported:${JSON.stringify(r.supportedVersions)}`) : null;
  t.serverInfo = r?.serverInfo;
  t.instructions = r?.instructions;
  t.capabilities = r?.capabilities;
  t.discoverRaw = r ? Object.keys(r) : disc;
  const call = (method, params = {}) => {
    const name = method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : method === 'prompts/get' ? params.name : undefined;
    const hdr = { 'mcp-protocol-version': MODERN, 'mcp-method': method };
    if (name !== undefined) hdr['mcp-name'] = /^[\x20-\x7e]*$/.test(name) ? name : `=?base64?${Buffer.from(name).toString('base64')}?=`;
    return post({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: meta } }, hdr);
  };
  t.call = call;
  return t;
}

function toolView(tool) {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title,
    hasOutputSchema: !!tool.outputSchema,
    annotations: tool.annotations,
    meta: tool._meta,
    desc: (tool.description ?? '').slice(0, 50),
  };
}

async function exercise(s, out) {
  out.negotiated = s.negotiated;
  out.serverInfo = s.serverInfo;
  out.instructions = s.instructions;
  out.capabilities = s.capabilities;
  if (s.era === 'modern' && !s.negotiated) {
    out.discoverFailure = brief(s.steps.discover) ?? null;
    out.discoverRaw = s.steps.discover?.raw;
  }
  const tools = await s.call('tools/list');
  out.toolsListMeta = tools.json?.result ? Object.fromEntries(Object.entries(tools.json.result).filter(([k]) => k !== 'tools')) : brief(tools);
  const toolList = tools.json?.result?.tools ?? [];
  out.tools = toolList.map(toolView);
  const res = await s.call('resources/list');
  const resources = res.json?.result?.resources ?? [];
  out.resources = res.json?.result ? resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })) : brief(res);
  out.calls = {};
  for (const t of toolList) {
    const args = /echo/.test(t.name) ? { text: 'x' } : {};
    const r = await s.call('tools/call', { name: t.name, arguments: args });
    const v = r.json?.result;
    out.calls[t.name] = v
      ? {
          status: r.status,
          isError: v.isError,
          text: v.content?.filter((c) => c.type === 'text').map((c) => c.text.slice(0, 120)),
          structuredContent: v.structuredContent,
          resourceLinks: v.content?.filter((c) => c.type === 'resource_link').map((c) => ({ uri: c.uri, name: c.name })),
          resultType: v.resultType,
          ms: r.ms,
        }
      : { ...brief(r), ms: r.ms };
  }
  out.reads = {};
  for (const r of resources) {
    const rr = await s.call('resources/read', { uri: r.uri });
    const v = rr.json?.result;
    out.reads[r.uri] = v ? { contents: v.contents?.map((c) => ({ uri: c.uri, text: c.text?.slice(0, 80) })), ttlMs: v.ttlMs, cacheScope: v.cacheScope } : brief(rr);
  }
  // A resource_link is only usable if the URI it carries can be read back through the same endpoint.
  out.linkReadback = {};
  for (const [name, c] of Object.entries(out.calls)) {
    for (const l of c.resourceLinks ?? []) {
      const rr = await s.call('resources/read', { uri: l.uri });
      out.linkReadback[`${name} -> ${l.uri}`] = rr.json?.result ? { ok: true, uri: rr.json.result.contents?.[0]?.uri } : brief(rr);
    }
  }
  const prompts = await s.call('prompts/list');
  out.prompts = prompts.json?.result ? prompts.json.result.prompts?.length : brief(prompts);
}

const report = {};
const eras = era === 'both' ? ['legacy', 'modern'] : [era];
for (const e of eras) {
  const out = {};
  report[e] = out;
  try {
    const s = e === 'legacy' ? await legacySession() : await modernSession();
    await exercise(s, out);
  } catch (err) {
    out.fatal = String(err?.cause?.code ?? err?.message ?? err);
  }
}
if (argv.out) writeFileSync(argv.out, JSON.stringify(report, null, 1));

for (const [e, o] of Object.entries(report)) {
  console.log(`== ${e}: negotiated=${o.negotiated} server=${o.serverInfo?.name ?? ''}/${o.serverInfo?.version ?? ''} ${o.fatal ? `FATAL ${o.fatal}` : ''}`);
  if (o.discoverFailure) console.log('   discover failed:', JSON.stringify(o.discoverFailure).slice(0, 300));
  console.log(`   instructions: ${JSON.stringify(o.instructions)?.slice(0, 200)}`);
  console.log(`   tools: ${Array.isArray(o.tools) ? o.tools.map((t) => t.name + (t.hasOutputSchema ? '[out]' : '') + (t.meta ? '[_meta]' : '')).join(', ') : JSON.stringify(o.tools)}  listMeta=${JSON.stringify(o.toolsListMeta)?.slice(0, 120)}`);
  console.log(`   resources: ${Array.isArray(o.resources) ? o.resources.map((r) => r.uri).join(', ') : JSON.stringify(o.resources)}`);
  for (const [k, v] of Object.entries(o.calls ?? {})) console.log(`   call ${k}: ${JSON.stringify(v).slice(0, 260)}`);
  for (const [k, v] of Object.entries(o.reads ?? {})) console.log(`   read ${k}: ${JSON.stringify(v).slice(0, 200)}`);
  for (const [k, v] of Object.entries(o.linkReadback ?? {})) console.log(`   linkReadback ${k}: ${JSON.stringify(v).slice(0, 200)}`);
  console.log(`   prompts: ${JSON.stringify(o.prompts)}`);
}
