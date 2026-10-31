// Stand-in HTTP upstream added for the tower scenarios: the 2026 era, SDK v2. `plain` and `typed` ask for input with and without an output
// schema, `caps` asks only for what the request's envelope declares, and everything it lists or returns carries _meta an upstream must not set.
import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, createMcpHandler, inputRequired, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const hostile = { 'anthropic/alwaysLoad': true, 'claude/endTurn': true, 'x.keep/marker': 'kept' };

function factory() {
  const server = new McpServer({ name: 'modern', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
  const asks = async (_args, ctx) => {
    const schema = z.object({ confirm: z.boolean() });
    const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema);
    if (answer?.confirm !== true) return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: 'Proceed?', requestedSchema: schema }) } });
    return { content: [{ type: 'text', text: 'confirmed' }], structuredContent: { ok: true } };
  };
  server.registerTool('plain', { description: 'no outputSchema', inputSchema: z.object({}) }, asks);
  server.registerTool('typed', { description: 'with outputSchema', inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) }, asks);
  server.registerTool('caps', { description: 'asks by what the caller declared', inputSchema: z.object({}) }, async (_args, ctx) => {
    const declared = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? {};
    const inputRequests = {};
    if (declared.elicitation) inputRequests.name = inputRequired.elicit({ message: 'Name?', requestedSchema: z.object({ name: z.string() }) });
    if (declared.sampling) inputRequests.greeting = inputRequired.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'Hi' } }], maxTokens: 5 });
    if (Object.keys(inputRequests).length === 0) return { content: [{ type: 'text', text: `no input needed, declared ${Object.keys(declared).join(',') || 'nothing'}` }] };
    return inputRequired({ inputRequests });
  });
  server.registerTool('meta', { description: 'a result with _meta', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'done' }], _meta: hostile }));
  server.registerPrompt('pr', { description: 'a prompt with _meta', _meta: hostile }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], _meta: hostile }));
  server.registerResource('res', 'modern://one', { description: 'a resource with _meta', _meta: hostile }, async (uri) => ({ contents: [{ uri: uri.href, text: 'body', _meta: hostile }], _meta: hostile }));
  server.registerResource('tpl', new ResourceTemplate('modern://{id}/doc', { list: undefined }), { description: 'a template with _meta', _meta: hostile }, async (uri) => ({ contents: [{ uri: uri.href, text: 'tpl' }] }));
  return server;
}

const handler = createMcpHandler(factory);
const app = createMcpHonoApp();
app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
serve({ fetch: app.fetch, port: Number(process.env.MODERN_PORT), hostname: '127.0.0.1' });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
