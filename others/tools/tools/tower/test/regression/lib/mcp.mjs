// Raw MCP client over fetch, adapted from the S1 harness lib.mjs. No SDK, so nothing hides what the gateway sent.
// Differences from the original: a connect timeout on every request, and an explicit per-request cap.
import { connectFetch } from './http.mjs';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';
const clientInfo = { name: 'tower-regression', version: '0.0.1' };
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': clientInfo,
  'io.modelcontextprotocol/clientCapabilities': {},
};
let id = 0;

export async function post(url, body, headers = {}, bearer, timeoutMs = 20000) {
  const t0 = performance.now();
  const auth = bearer ? { authorization: `Bearer ${bearer}` } : {};
  try {
    const res = await connectFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let json = null;
    const frames = []; // Notifications that came before the result on an SSE response.
    if (ct.includes('text/event-stream')) {
      for (const l of text.split(/\r?\n/)) {
        if (!l.startsWith('data:')) continue;
        try { const o = JSON.parse(l.slice(5).trim()); if ('result' in o || 'error' in o) json = o; else frames.push(o); } catch {}
      }
    } else if (text) {
      try { json = JSON.parse(text); } catch {}
    }
    return { status: res.status, session: res.headers.get('mcp-session-id'), json, frames, raw: json ? undefined : text.slice(0, 300), ms: +(performance.now() - t0).toFixed(1) };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { status: 0, json: null, raw: `FETCH ${timedOut ? 'TIMEOUT' : (e?.cause?.code ?? e?.name ?? e)}`, timedOut, ms: +(performance.now() - t0).toFixed(1) };
  }
}

// open(url, 'legacy'|'modern', bearer) -> { era, negotiated, session, call(method, params, timeoutMs) }
export async function open(url, era, bearer, timeoutMs = 20000) {
  if (era === 'legacy') {
    const init = await post(url, { jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo } }, {}, bearer, timeoutMs);
    const session = init.session;
    const negotiated = init.json?.result?.protocolVersion;
    const h = { 'mcp-protocol-version': negotiated ?? LEGACY, ...(session ? { 'mcp-session-id': session } : {}) };
    await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, h, bearer, timeoutMs);
    return { era, session, negotiated, init, instructions: init.json?.result?.instructions, call: (m, p = {}, t = timeoutMs) => post(url, { jsonrpc: '2.0', id: ++id, method: m, params: p }, h, bearer, t) };
  }
  const disc = await post(url, { jsonrpc: '2.0', id: ++id, method: 'server/discover', params: { _meta: meta } }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' }, bearer, timeoutMs);
  const r = disc.json?.result;
  return {
    era,
    negotiated: r?.supportedVersions?.includes(MODERN) ? MODERN : null,
    discover: disc,
    instructions: r?.instructions,
    call: (m, p = {}, t = timeoutMs) => {
      const n = m === 'tools/call' || m === 'prompts/get' ? p.name : m === 'resources/read' ? p.uri : undefined;
      const hdr = { 'mcp-protocol-version': MODERN, 'mcp-method': m };
      if (n !== undefined) hdr['mcp-name'] = /^[\x20-\x7e]*$/.test(n) ? n : `=?base64?${Buffer.from(n).toString('base64')}?=`;
      return post(url, { jsonrpc: '2.0', id: ++id, method: m, params: { ...p, _meta: { ...meta, ...p._meta } } }, hdr, bearer, t);
    },
  };
}

export function outcome(r) {
  if (r.json?.result) {
    const v = r.json.result;
    if (v.tools) return `tools=[${v.tools.map((t) => t.name).join(',')}]`;
    if (v.isError) return `isError "${JSON.stringify(v.content).slice(0, 110)}"`;
    if (v.content) return `ok "${(v.content.find((c) => c.type === 'text')?.text ?? '').slice(0, 70)}"`;
    return 'ok';
  }
  if (r.json?.error) return `rpcError ${r.json.error.code} "${String(r.json.error.message).slice(0, 110)}" http=${r.status}`;
  return `http=${r.status} ${String(r.raw ?? '').slice(0, 110)}`;
}

export const toolNames = (r) => r.json?.result?.tools?.map((t) => t.name) ?? null;
export const textOf = (r) => r.json?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
export const isOk = (r) => !!r.json?.result && !r.json.result.isError;
// A call "failed" in any of the three ways a gateway can fail it: transport, JSON-RPC error, isError result.
export const failed = (r) => !r.json?.result || !!r.json.result.isError;
export const failKind = (r) => (r.json?.result?.isError ? 'isError' : r.json?.error ? `rpc${r.json.error.code}` : r.status === 0 ? (r.timedOut ? 'timeout' : 'transport') : r.json?.result ? 'ok' : `http${r.status}`);
export const callTool = (s, name, args = {}, t) => s.call('tools/call', { name, arguments: args }, t);

// Open a notification stream (legacy GET stream or modern subscriptions/listen). Returns { seen, info, close() }.
export function listen(url, s, bearer) {
  const seen = [];
  const ac = new AbortController();
  const headers = { accept: 'text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
  const state = { seen, info: 'none', ended: false, endedAt: null, startedAt: performance.now(), close: () => ac.abort() };
  (async () => {
    try {
      let res;
      if (s.era === 'legacy') {
        res = await connectFetch(url, { headers: { ...headers, 'mcp-protocol-version': s.negotiated, ...(s.session ? { 'mcp-session-id': s.session } : {}) }, signal: ac.signal });
      } else {
        res = await connectFetch(url, {
          method: 'POST',
          headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'subscriptions/listen' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true, resourcesListChanged: true }, _meta: meta } }),
          signal: ac.signal,
        });
      }
      state.info = `http=${res.status}`;
      state.status = res.status;
      const rd = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        for (const l of dec.decode(value).split(/\r?\n/)) {
          if (l.startsWith('data:') && l.length > 6) { try { seen.push({ method: JSON.parse(l.slice(5).trim()).method ?? 'response', at: performance.now() }); } catch { seen.push({ method: 'unparsed', at: performance.now() }); } }
        }
      }
      state.ended = true; state.endedAt = performance.now();
    } catch (e) {
      if (e.name !== 'AbortError') { state.info += ` err=${e?.cause?.code ?? e.message}`; state.ended = true; state.endedAt = performance.now(); }
    }
  })();
  return state;
}
