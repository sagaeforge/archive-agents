// A real server on the v1 TypeScript SDK, as most existing external servers are built.
import { appendFileSync } from 'node:fs';
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
const LOG = process.env.SPAWN_LOG ?? '';
const stamp = (ev) => { if (LOG) appendFileSync(LOG, JSON.stringify({ ev, pid: process.pid, t: Date.now() }) + '\n'); };
stamp('spawn');
process.on('exit', () => stamp('exit'));
const s = new Server({ name: 'realts', version: '1.0.0' }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'status', description: 'REALTS status', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo', description: 'REALTS echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: `realts ${r.params.name} ${JSON.stringify(r.params.arguments ?? {})} pid=${process.pid}` }] }));
await s.connect(new StdioServerTransport());
