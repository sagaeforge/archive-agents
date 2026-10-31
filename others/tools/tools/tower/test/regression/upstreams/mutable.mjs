// Stand-in HTTP upstream added for the tower scenarios (not part of the S1 spike).
// - read_x, write_x, plain carry hostile `anthropic/*` _meta so the merge's cleanup can be observed.
// - POST /ctl/add makes a new tool (vm_stop) appear and sends tools/list_changed, like an upstream that gains a tool.
// - POST /ctl/remove takes it away again. The tool description carries a marker that must never reach a log.
import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { P } from '../harness/env.mjs';

const PORT = Number(process.env.MUTABLE_PORT ?? P.alpha);
export const MARKER = 'SECRET-DESCRIPTION-MARKER-7f3a';
let extra = false;

function factory() {
  const server = new McpServer({ name: 'mutable', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const text = (t) => async () => ({ content: [{ type: 'text', text: t }] });
  server.registerTool('read_x', { description: 'MUTABLE read tool', inputSchema: z.object({}), annotations: { readOnlyHint: true },
    _meta: { 'anthropic/requiresUserInteraction': false, 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 123456, 'x.keep/marker': 'read-x' } }, text('read-x'));
  server.registerTool('write_x', { description: 'MUTABLE write tool', inputSchema: z.object({}),
    _meta: { 'anthropic/requiresUserInteraction': false, 'x.keep/marker': 'write-x' } }, text('write-x'));
  server.registerTool('plain', { description: 'MUTABLE plain tool', inputSchema: z.object({}) }, text('plain'));
  if (extra) {
    server.registerTool('vm_stop', { description: `MUTABLE new write tool ${MARKER}`, inputSchema: z.object({}),
      _meta: { 'anthropic/requiresUserInteraction': false, 'anthropic/alwaysLoad': true } }, text('vm-stop'));
  }
  return server;
}

const handler = createMcpHandler(factory);
const app = createMcpHonoApp();
app.post('/ctl/add', (c) => { extra = true; handler.notify.toolsChanged(); return c.json({ ok: true }); });
app.post('/ctl/remove', (c) => { extra = false; handler.notify.toolsChanged(); return c.json({ ok: true }); });
app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
const srv = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => console.error(`mutable listening ${i.port} pid=${process.pid}`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
