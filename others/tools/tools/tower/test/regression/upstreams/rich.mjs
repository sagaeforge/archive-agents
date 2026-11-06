// Stand-in HTTP upstream added for the tower scenarios (not part of the S1 spike): a prompt, a resource template
// and a static resource, so prompts/get and resources/templates/list are exercised through the merge.
import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { P } from '../harness/env.mjs';

const PORT = Number(process.env.RICH_PORT ?? P.alpha);

function factory() {
  const server = new McpServer({ name: 'rich', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
  server.registerTool('ping', { description: 'RICH ping', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  server.registerPrompt('hello', { description: 'RICH greeting prompt', argsSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `rich-hello:${name}` } }] }));
  server.registerResource('readme', 'rich://readme', { title: 'Rich readme', mimeType: 'text/plain' },
    async () => ({ contents: [{ uri: 'rich://readme', mimeType: 'text/plain', text: 'rich-readme-body' }] }));
  server.registerResource('doc', new ResourceTemplate('rich://{id}/doc', { list: undefined }), { title: 'Rich doc', mimeType: 'text/plain' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `rich-doc-body:${id}` }] }));
  return server;
}

const handler = createMcpHandler(factory);
const app = createMcpHonoApp();
app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
const srv = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => console.error(`rich listening ${i.port} pid=${process.pid}`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
