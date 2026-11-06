// Stand-in upstream "alpha": Streamable HTTP, SDK v2, 2 tools + 1 resource.
// Tool `status` deliberately collides with beta's `status`.
import { appendFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { acceptedContent, createMcpHandler, inputRequired, McpServer, ResourceTemplate, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const PORT = Number(process.env.ALPHA_PORT ?? 18101);
const SNAPSHOT_URI = 'kb://alpha/snapshot/1';
const KOREAN_URI = 'kb://alpha/스냅샷/1';
const EXTRA = process.env.ALPHA_EXTRA === '1';
const EVENTS = process.env.ALPHA_EVENTS ?? '/dev/null';
const TOOL_SUFFIX = process.env.ALPHA_TOOL_SUFFIX ?? '';
const NAME = process.env.ALPHA_NAME ?? 'alpha';
let calls = 0;

function factory() {
  const server = new McpServer(
    { name: NAME, version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: `${NAME.toUpperCase()}_INSTRUCTIONS: use ${NAME} for snapshots.`,
    },
  );

  server.registerTool(
    `status${TOOL_SUFFIX}`,
    {
      title: 'Alpha status',
      description: 'ALPHA status with structured output',
      inputSchema: z.object({ verbose: z.boolean().optional() }),
      outputSchema: z.object({ source: z.string(), pid: z.number(), calls: z.number() }),
      annotations: { readOnlyHint: true },
      _meta: { 'anthropic/alwaysLoad': true, 'x.spike/marker': 'alpha-status' },
    },
    async () => {
      calls += 1;
      const structuredContent = { source: NAME, pid: process.pid, calls };
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    },
  );

  server.registerTool(
    `link_doc${TOOL_SUFFIX}`,
    {
      description: 'ALPHA returns a resource_link to its snapshot',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        { type: 'text', text: `see ${SNAPSHOT_URI}` },
        { type: 'resource_link', uri: SNAPSHOT_URI, name: 'alpha-snapshot', mimeType: 'text/plain' },
      ],
    }),
  );

  server.registerResource(
    'alpha-snapshot',
    SNAPSHOT_URI,
    { title: 'Alpha snapshot', description: 'alpha resource', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href ?? String(uri), mimeType: 'text/plain', text: `alpha-body from ${process.pid}` }] }),
  );

  if (EXTRA) {
    server.registerTool(
      'slow',
      { description: 'ALPHA slow tool for relay tests', inputSchema: z.object({ ms: z.number() }) },
      async ({ ms }, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        const started = Date.now();
        let cancelled = false;
        ctx.mcpReq.signal?.addEventListener('abort', () => { cancelled = true; appendFileSync(EVENTS, `${JSON.stringify({ ev: 'cancelled', after: Date.now() - started })}
`); });
        for (let i = 1; !cancelled && Date.now() - started < ms; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (token !== undefined) await ctx.mcpReq.notify?.({ method: 'notifications/progress', params: { progressToken: token, progress: i } }).catch(() => {});
        }
        appendFileSync(EVENTS, `${JSON.stringify({ ev: cancelled ? 'stopped' : 'done', after: Date.now() - started, token: token !== undefined })}
`);
        return { content: [{ type: 'text', text: `slept ${Date.now() - started}` }] };
      },
    );
    // Multi round trip: asks the client for input, which a gateway must relay.
    server.registerTool(
      'confirm',
      { description: 'ALPHA asks for confirmation through input_required', inputSchema: z.object({}) },
      async (_args, ctx) => {
        const schema = z.object({ confirm: z.boolean() });
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema);
        if (answer?.confirm !== true) return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: 'Proceed?', requestedSchema: schema }) } });
        return { content: [{ type: 'text', text: 'confirmed' }] };
      },
    );
    // McpServer looks static URIs up through new URL(uri).href, which percent-encodes them,
    // so a raw non-ASCII URI only reads back through a template.
    server.registerResource(
      'alpha-korean',
      new ResourceTemplate('kb://alpha/{slug}/1', { list: async () => ({ resources: [{ uri: KOREAN_URI, name: 'alpha-korean', mimeType: 'text/plain' }] }) }),
      { title: 'Korean URI', mimeType: 'text/plain' },
      async () => ({ contents: [{ uri: KOREAN_URI, mimeType: 'text/plain', text: 'korean-uri-body' }] }),
    );
  }
  return server;
}

const handler = createMcpHandler(factory);
const app = createMcpHonoApp();
if (process.env.ALPHA_STATEFUL === '1') {
  // Legacy-only upstream with real sessions: a restart invalidates every session id.
  const sessions = new Map();
  app.all('/mcp', async (c) => {
    const sid = c.req.header('mcp-session-id');
    let t = sid ? sessions.get(sid) : undefined;
    if (!t) {
      if (sid) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, 404);
      t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
      await factory().connect(t);
    }
    return t.handleRequest(c.req.raw, { parsedBody: c.get('parsedBody') });
  });
} else {
  app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
}
const srv = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => {
  console.error(`${NAME} listening ${i.address}:${i.port} pid=${process.pid}`);
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
