// A real server on the v1 TypeScript SDK, as most existing external servers are built.
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const SDK = '/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/c4-1mcp/node_modules/@modelcontextprotocol/sdk/dist/esm';
const { Server } = await import(`${SDK}/server/index.js`);
const { StdioServerTransport } = await import(`${SDK}/server/stdio.js`);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(`${SDK}/types.js`);
const LOG = process.env.SPAWN_LOG ?? '/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/review/t/spawn.log';
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
