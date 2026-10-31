// An upstream that hangs rather than dies: SIGSTOP the stdio child, then measure the merged endpoint.
// usage: hang.mjs <name> <url> <legacy|modern> <bearer|->
import { open, outcome, pick, post } from './lib.mjs';

const [name, url, era, bearerArg] = process.argv.slice(2);
const bearer = bearerArg === '-' ? undefined : bearerArg;
const CAP = 85000;
const s = await open(url, era, bearer);
const list = await s.call('tools/list');
const { a, b } = pick(list.json.result.tools);
const ec = (r) => r.json?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
const r0 = await s.call('tools/call', { name: b, arguments: { text: 'x' } });
const pid = Number(/pid=(\d+)/.exec(ec(r0))?.[1]);
process.kill(pid, 'SIGSTOP');

// A capped raw request, so a stall is measured rather than cut off by the harness default.
const hdr = (method, n) => (era === 'modern'
  ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(n ? { 'mcp-name': n } : {}) }
  : { 'mcp-protocol-version': s.negotiated, ...(s.session ? { 'mcp-session-id': s.session } : {}) });
const meta = era === 'modern' ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'hang', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : {};
const req = (id, method, params, n) => post(url, { jsonrpc: '2.0', id, method, params: { ...params, ...meta } }, hdr(method, n), bearer, CAP);
const show = (r) => `${outcome(r).slice(0, 72)} (${r.ms} ms)`;

const [l, ca, cb] = await Promise.all([
  req(9001, 'tools/list', {}),
  req(9002, 'tools/call', { name: a, arguments: {} }, a),
  req(9003, 'tools/call', { name: b, arguments: { text: 'x' } }, b),
]);
process.kill(pid, 'SIGCONT');
console.log(`${name.padEnd(13)} ${era}\n  tools/list  ${show(l)}\n  call alpha  ${show(ca)}\n  call beta   ${show(cb)}`);
process.exit(0);
