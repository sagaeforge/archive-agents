// The smallest composition that merges tools and resources over HTTP and stdio.
// No reconnect, no hot reload, no auth, no prompts. It exists to size the floor.
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

const config = JSON.parse(readFileSync(new URL('./upstreams.orig.json', import.meta.url), 'utf8'));
const upstreams = await Promise.all(
  Object.entries(config).map(async ([name, cfg]) => {
    const client = new Client({ name: 'gw', version: '0.0.1' });
    await client.connect(cfg.url ? new StreamableHTTPClientTransport(new URL(cfg.url)) : new StdioClientTransport(cfg));
    return { name, client };
  }),
);
const merge = async (fn) => (await Promise.all(upstreams.map(fn))).flat();

const handler = createMcpHandler(() => {
  const instructions = upstreams.map((u) => `[${u.name}]\n${u.client.getInstructions() ?? ''}`).join('\n\n');
  const server = new Server({ name: 'gw', version: '0.0.1' }, { capabilities: { tools: {}, resources: {} }, instructions });
  server.setRequestHandler('tools/list', async () => ({
    tools: await merge(async (u) => (await u.client.listTools()).tools.map((t) => ({ ...t, name: `${u.name}_${t.name}` }))),
  }));
  server.setRequestHandler('tools/call', async ({ params }) => {
    const u = upstreams.find((x) => params.name.startsWith(`${x.name}_`));
    return u.client.callTool({ ...params, name: params.name.slice(u.name.length + 1) });
  });
  server.setRequestHandler('resources/list', async () => ({ resources: await merge(async (u) => (await u.client.listResources()).resources) }));
  server.setRequestHandler('resources/read', async ({ params }) => {
    for (const u of upstreams) {
      const result = await u.client.readResource(params).catch(() => null);
      if (result) return result;
    }
    throw new Error(`unknown resource ${params.uri}`);
  });
  return server;
});

const app = createMcpHonoApp();
app.all('/mcp', (c) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
serve({ fetch: app.fetch, port: Number(process.env.GW_PORT ?? 18151), hostname: '127.0.0.1' });
