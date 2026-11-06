// Stand-in stdio upstream added for the tower scenarios: the 2025 handshake with no SDK, so a failure can be put on any one message.
// Behaviour comes from the environment, and EVENTS names a file that gets one JSON line per thing the child saw or did.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const E = process.env;
const name = process.argv[2] ?? 'fake';
const log = (ev, x = {}) => { if (E.EVENTS) appendFileSync(E.EVENTS, `${JSON.stringify({ t: Date.now(), name, pid: process.pid, ev, ...x })}\n`); };
log('spawn');
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const n = (k, d = 0) => (E[k] ? Number(E[k]) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let listCount = 0;
let tplCount = 0;
const cancelled = new Set();
if (E.STDERR_TEXT) process.stderr.write(E.STDERR_TEXT + 'x'.repeat(n('STDERR_PAD')));
if (E.IGNORE_TERM) process.on('SIGTERM', () => log('sigterm_ignored'));
else process.on('SIGTERM', () => { log('sigterm'); process.exit(143); });
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void handle(JSON.parse(l)); } });
process.stdin.on('end', () => { log('stdin_eof'); if (!E.IGNORE_EOF) process.exit(0); });
if (E.IGNORE_EOF) setInterval(() => {}, 1000);
const tools = () => {
  const extra = E.TOOLS_AFTER && listCount > n('TOOLS_AFTER') ? [{ name: 'late', description: 'late', inputSchema: { type: 'object' } }] : [];
  if (E.NO_TOOLS_FIRST && listCount <= n('NO_TOOLS_FIRST')) return [];
  const list = [
    { name: 'echo', description: `echo from ${name}`, inputSchema: { type: 'object', properties: {} } },
    { name: 'slow', description: 'slow', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
    { name: 'die', description: 'exit mid-call', inputSchema: { type: 'object' } },
    { name: 'big', description: 'big result', inputSchema: { type: 'object', properties: { bytes: { type: 'number' } } } },
    ...extra,
  ];
  if (E.MALFORMED_AFTER && listCount > n('MALFORMED_AFTER')) list.push({ name: 'broken', description: 'no inputSchema' });
  return list;
};
async function handle(m) {
  log('rx', { method: m.method, id: m.id, req: m.params?.requestId, meta: m.params?._meta, name: m.params?.name });
  if (m.method === 'notifications/cancelled') { cancelled.add(m.params.requestId); log('cancelled', { req: m.params.requestId }); return; }
  if (m.id === undefined) return;
  switch (m.method) {
    case 'initialize': {
      await sleep(n('INIT_DELAY_MS'));
      if (E.INIT_HANG) return;
      const capabilities = { tools: E.TOOLS_LC ? { listChanged: true } : {}, ...(E.PROMPTS ? { prompts: {} } : {}), ...(E.RESOURCES ? { resources: {} } : {}) };
      reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities, serverInfo: { name, version: '1' }, ...(E.INSTRUCTIONS && { instructions: E.INSTRUCTIONS.repeat(n('INSTR_REPEAT', 1)) }) });
      if (E.FLAP_FILE) { let c = 0; try { c = Number(readFileSync(E.FLAP_FILE, 'utf8')); } catch {} writeFileSync(E.FLAP_FILE, String(c + 1)); if (c < n('FLAP_COUNT')) setTimeout(() => process.exit(1), 50); }
      if (E.EXIT_AFTER_INIT_MS) setTimeout(() => { log('flap_exit'); process.exit(1); }, n('EXIT_AFTER_INIT_MS'));
      return;
    }
    case 'tools/list': {
      listCount += 1;
      const d = listCount === 1 ? n('FIRST_LIST_DELAY_MS') : n('LIST_DELAY_MS');
      await sleep(d);
      if (E.LIST_HANG) return;
      return reply(m.id, { tools: tools() });
    }
    case 'prompts/list': if (E.PROMPTS === 'fail') return fail(m.id, -32603, 'prompts broken'); if (E.PROMPTS === 'hang') return; return reply(m.id, { prompts: [{ name: 'p', description: 'p' }] });
    case 'resources/read':
      if (E.READ_OK) return reply(m.id, { contents: [{ uri: m.params.uri, text: 'read-body' }] });
      await sleep(n('DIE_DELAY_MS', 100));
      process.exit(7);
      break;
    case 'prompts/get': {
      if (E.PROMPT_DIE) { await sleep(100); process.exit(7); }
      const tok = m.params._meta?.progressToken;
      if (tok !== undefined) { send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tok, progress: 1, total: 2, message: 'progress of the prompts/get' } }); await sleep(50); }
      return reply(m.id, { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] });
    }
    case 'resources/list': return reply(m.id, { resources: [{ uri: 'fake://one', name: 'one' }] });
    case 'resources/templates/list': {
      tplCount += 1;
      if (E.TEMPLATES_HANG_FROM && tplCount >= n('TEMPLATES_HANG_FROM') && tplCount <= n('TEMPLATES_HANG_TO', 1e9)) return;
      return reply(m.id, { resourceTemplates: [{ uriTemplate: 'fake://{id}', name: 'by-id' }] });
    }
    case 'tools/call': {
      const a = m.params.arguments ?? {};
      const tok = m.params._meta?.progressToken;
      if (m.params.name === 'echo') return reply(m.id, { content: [{ type: 'text', text: `pid=${process.pid}` }] });
      if (m.params.name === 'die') { await sleep(n('DIE_DELAY_MS', 100)); log('dying'); process.exit(7); }
      if (m.params.name === 'big') return reply(m.id, { content: [{ type: 'text', text: 'x'.repeat(a.bytes) }] });
      if (m.params.name === 'slow') {
        const steps = a.steps ?? 0; const ms = a.ms ?? 1000;
        for (let i = 0; i < steps; i++) { await sleep(ms / steps); if (cancelled.has(m.id)) { log('stopped', { id: m.id }); return; } if (tok !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tok, progress: i + 1, total: steps } }); }
        if (!steps) await sleep(ms);
        if (cancelled.has(m.id)) { log('stopped', { id: m.id }); return; }
        log('done', { id: m.id });
        return reply(m.id, { content: [{ type: 'text', text: `slept ${ms}` }] });
      }
      return fail(m.id, -32602, 'unknown tool');
    }
    default: return fail(m.id, -32601, 'method not found');
  }
}
