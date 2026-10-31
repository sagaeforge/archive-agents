// Summarize one real Claude Code run. usage: ccsummary.mjs <dir>
import { existsSync, readFileSync } from 'node:fs';

const dir = process.argv[2];
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const ev = lines(`${dir}/out.jsonl`).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = ev.find((e) => e.type === 'system' && e.subtype === 'init');
console.log('claude_code', init?.claude_code_version, 'model', init?.model);
console.log('mcp_servers', JSON.stringify(init?.mcp_servers));
const mcpTools = (init?.tools ?? []).filter((t) => t.startsWith('mcp__'));
console.log(`init tools (${(init?.tools ?? []).length}): builtin=${(init?.tools ?? []).filter((t) => !t.startsWith('mcp__')).join(',')}`);
console.log(`init mcp tools (${mcpTools.length}): ${mcpTools.join(', ')}`);
const results = new Map();
const uses = [];
for (const e of ev) {
  for (const c of e.message?.content ?? []) {
    if (c.type === 'tool_use') uses.push(c);
    if (c.type === 'tool_result') results.set(c.tool_use_id, c);
  }
}
for (const u of uses) {
  const r = results.get(u.id);
  const body = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content);
  console.log(`tool_use ${u.name} ${JSON.stringify(u.input).slice(0, 90)} => ${r?.is_error ? 'ERROR ' : ''}${(body ?? '').slice(0, 200)}`);
}
const fin = ev.find((e) => e.type === 'result');
console.log(`result: subtype=${fin?.subtype} turns=${fin?.num_turns} cost=$${fin?.total_cost_usd?.toFixed?.(4)} duration=${fin?.duration_ms} ms`);
console.log(`final text: ${(fin?.result ?? '').slice(0, 900)}`);
const tapAll = lines(`${dir}/tap.jsonl`).map((l) => JSON.parse(l));
const tap = tapAll.filter((r) => !r.started);
const open = tapAll.filter((r) => r.started && !tap.some((d) => d.t === r.t && d.method === r.method));
if (open.length) console.log('requests still open when the tap stopped:', open.map((r) => `${r.http} ${r.method ?? ''}`).join(', '));
console.log(`-- wire (${tap.length} requests):`);
const seq = tap.map((r) => `${r.http === 'POST' ? '' : `${r.http} `}${r.method ?? r.hdrMethod ?? ''}${r.name ? `(${String(r.name).slice(0, 34)})` : ''}=${r.status}${r.err ? `[${r.err.slice(0, 40)}]` : ''}`);
console.log(seq.join(' | ').slice(0, 1500));
const pv = [...new Set(tap.map((r) => r.hdrPv).filter(Boolean))];
console.log('header protocol versions:', pv.join(','), '| body versions:', [...new Set(tap.map((r) => r.pv).filter(Boolean))].join(','), '| negotiated:', [...new Set(tap.map((r) => r.negotiated).filter(Boolean))].join(','), '| supported:', [...new Set(tap.map((r) => r.supported).filter(Boolean))].join(','), '| sessions:', new Set(tap.map((r) => r.respSession ?? r.session).filter(Boolean)).size);
console.log('user-agent:', [...new Set(tap.map((r) => r.ua).filter(Boolean))].join(','));
const sp = lines(`${dir}/beta-spawn.log`);
console.log(`beta spawns=${sp.filter((l) => l.includes('"spawn"')).length} exits=${sp.filter((l) => l.includes('"exit"')).length}`);
