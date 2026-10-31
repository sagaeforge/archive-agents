// Minimal raw MCP client helpers shared by the lifecycle and count harnesses.
export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';
const clientInfo = { name: 's1-lib', version: '0.0.1' };
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let json = null;
    if (ct.includes('text/event-stream')) {
      for (const l of text.split(/\r?\n/)) {
        if (!l.startsWith('data:')) continue;
        try {
          const o = JSON.parse(l.slice(5).trim());
          if ('result' in o || 'error' in o) json = o;
        } catch {}
      }
    } else if (text) {
      try { json = JSON.parse(text); } catch {}
    }
    return { status: res.status, session: res.headers.get('mcp-session-id'), json, raw: json ? undefined : text.slice(0, 300), ms: +(performance.now() - t0).toFixed(1) };
  } catch (e) {
    return { status: 0, json: null, raw: `FETCH ${e?.cause?.code ?? e?.name ?? e}`, ms: +(performance.now() - t0).toFixed(1) };
  }
}

export async function open(url, era, bearer) {
  if (era === 'legacy') {
    const init = await post(url, { jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo } }, {}, bearer);
    const session = init.session;
    const negotiated = init.json?.result?.protocolVersion;
    const h = { 'mcp-protocol-version': negotiated ?? LEGACY, ...(session ? { 'mcp-session-id': session } : {}) };
    await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, h, bearer);
    return { era, session, negotiated, init, call: (m, p = {}) => post(url, { jsonrpc: '2.0', id: ++id, method: m, params: p }, h, bearer) };
  }
  const disc = await post(url, { jsonrpc: '2.0', id: ++id, method: 'server/discover', params: { _meta: meta } }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' }, bearer);
  const r = disc.json?.result;
  return {
    era,
    negotiated: r?.supportedVersions?.includes(MODERN) ? MODERN : null,
    discover: disc,
    call: (m, p = {}) => {
      const n = m === 'tools/call' || m === 'prompts/get' ? p.name : m === 'resources/read' ? p.uri : undefined;
      const hdr = { 'mcp-protocol-version': MODERN, 'mcp-method': m };
      if (n !== undefined) hdr['mcp-name'] = /^[\x20-\x7e]*$/.test(n) ? n : `=?base64?${Buffer.from(n).toString('base64')}?=`;
      return post(url, { jsonrpc: '2.0', id: ++id, method: m, params: { ...p, _meta: meta } }, hdr, bearer);
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

// Pick upstream tools by description so the harness works whatever a candidate calls them.
export function pick(tools) {
  const by = (re) => tools.find((t) => re.test(t.description ?? ''));
  return { a: by(/^(\[[^\]]*\]\s*)?ALPHA status/)?.name, l: by(/^(\[[^\]]*\]\s*)?ALPHA returns/)?.name, b: by(/^(\[[^\]]*\]\s*)?BETA echoes/)?.name, bs: by(/^(\[[^\]]*\]\s*)?BETA status/)?.name };
}
