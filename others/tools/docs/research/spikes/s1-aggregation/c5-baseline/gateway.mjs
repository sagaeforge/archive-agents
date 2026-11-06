// Smallest composition: SDK v2 client and server, one merged /mcp over HTTP and stdio upstreams.
// The SDK owns the protocol. This file only routes: fan out lists, prefix names, keep URIs as they are.
import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, ProtocolError, Server } from '@modelcontextprotocol/server';

const CONFIG = process.env.GW_CONFIG ?? new URL('./upstreams.json', import.meta.url).pathname;
const PORT = Number(process.env.GW_PORT ?? 18150);
const TOKEN = process.env.GW_TOKEN;
const RETRY_MS = Number(process.env.GW_RETRY_MS ?? 1000);
const INSTRUCTIONS_MAX = 4096; // Claude Code truncates server instructions here.
const INVALID_PARAMS = -32602;
const CALL_TIMEOUT_MS = 30 * 60 * 1000; // The SDK default of 60 s would cut long tools off.
const LIST = { timeout: Number(process.env.GW_LIST_TIMEOUT_MS ?? 3000) }; // A hung upstream must not stall the merged list.

const upstreams = new Map();
const uriOwner = new Map();

function changed() {
  handler.notify.toolsChanged();
  handler.notify.resourcesChanged();
  handler.notify.promptsChanged();
}

class Upstream {
  client = null;
  closed = false;
  timer = null;
  resetting = null;

  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.connect();
  }

  async connect() {
    if (this.closed) return;
    const { url, command, args, env, cwd } = this.cfg;
    // stdio stays on the 2025 handshake, which any external server speaks; HTTP probes for the modern era.
    const era = url ? { versionNegotiation: { mode: 'auto' } } : {};
    // Pass input_required through instead of answering it here; the real client owns the answer.
    const client = new Client({ name: 'gateway', version: '0.0.1' }, { ...era, capabilities: { elicitation: { form: {} } }, inputRequired: { autoFulfill: false } });
    client.setNotificationHandler('notifications/tools/list_changed', () => handler.notify.toolsChanged());
    client.setNotificationHandler('notifications/resources/list_changed', () => handler.notify.resourcesChanged());
    client.setNotificationHandler('notifications/prompts/list_changed', () => handler.notify.promptsChanged());
    client.onclose = () => {
      if (this.client === client) this.client = null;
      this.retry();
      changed();
    };
    try {
      const transport = url ? new StreamableHTTPClientTransport(new URL(url)) : new StdioClientTransport({ command, args, env, cwd });
      await client.connect(transport);
      this.client = client;
      changed();
    } catch {
      this.retry();
    }
  }

  // A restarted session-based HTTP upstream answers 404. Start a new session and retry once.
  async use(fn) {
    if (!this.client) throw new ProtocolError(INVALID_PARAMS, `upstream ${this.name} is down`);
    try {
      return await fn(this.client);
    } catch (err) {
      if (!(err instanceof SdkHttpError && err.status === 404)) throw err;
      this.resetting ??= this.reset().finally(() => {
        this.resetting = null;
      });
      await this.resetting;
      if (!this.client) throw err;
      return fn(this.client);
    }
  }

  async reset() {
    const stale = this.client;
    this.client = null;
    if (stale) {
      stale.onclose = undefined;
      await stale.close().catch(() => {});
    }
    await this.connect();
  }

  retry() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, RETRY_MS);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.client?.close();
  }
}

const live = () => [...upstreams.values()].filter((u) => u.client);

// One slow or dead upstream must not take the merged list down.
async function fanout(fn) {
  const settled = await Promise.allSettled(live().map(fn));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function allPages(list, key) {
  const items = [];
  let cursor;
  do {
    const page = await list(cursor ? { cursor } : undefined);
    items.push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function route(prefixed) {
  for (const u of upstreams.values()) {
    if (prefixed.startsWith(`${u.name}_`)) return { upstream: u, name: prefixed.slice(u.name.length + 1) };
  }
  throw new ProtocolError(INVALID_PARAMS, `unknown name: ${prefixed}`);
}

function mergedInstructions() {
  const text = live()
    .filter((u) => u.client.getInstructions())
    .map((u) => `[${u.name}]\n${u.client.getInstructions()}`)
    .join('\n\n');
  return text ? text.slice(0, INSTRUCTIONS_MAX) : undefined;
}

function createServer() {
  const server = new Server(
    { name: 'gateway', version: '0.0.1' },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
      instructions: mergedInstructions(),
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: await fanout(async (u) => (await allPages((p) => u.use((c) => c.listTools(p, LIST)), 'tools')).map((t) => ({ ...t, name: `${u.name}_${t.name}` }))),
  }));

  server.setRequestHandler('tools/call', async ({ params }, ctx) => {
    const { upstream, name } = route(params.name);
    if (!upstream.client) return { isError: true, content: [{ type: 'text', text: `upstream ${upstream.name} is down` }] };
    const token = ctx.mcpReq._meta?.progressToken;
    const onprogress = token === undefined ? undefined : (p) => ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...p, progressToken: token } });
    const options = { signal: ctx.mcpReq.signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, onprogress, allowInputRequired: true };
    const retry = ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses, requestState: ctx.mcpReq.requestState() } : {};
    return upstream.use((c) => c.callTool({ ...params, ...retry, name }, options));
  });

  server.setRequestHandler('prompts/list', async () => ({
    prompts: await fanout(async (u) => (await allPages((p) => u.use((c) => c.listPrompts(p, LIST)), 'prompts')).map((t) => ({ ...t, name: `${u.name}_${t.name}` }))),
  }));

  server.setRequestHandler('prompts/get', async ({ params }) => {
    const { upstream, name } = route(params.name);
    return upstream.use((c) => c.getPrompt({ ...params, name }));
  });

  // URIs pass through unchanged, so a resource_link in a tool result stays readable here.
  server.setRequestHandler('resources/list', async () => ({
    resources: await fanout(async (u) => {
      const resources = await allPages((p) => u.use((c) => c.listResources(p, LIST)), 'resources');
      for (const r of resources) uriOwner.set(r.uri, u);
      return resources;
    }),
  }));

  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: await fanout((u) => allPages((p) => u.use((c) => c.listResourceTemplates(p, LIST)), 'resourceTemplates')),
  }));

  server.setRequestHandler('resources/read', async ({ params }) => {
    const owner = uriOwner.get(params.uri);
    const candidates = owner?.client ? [owner] : live();
    let failure;
    for (const u of candidates) {
      try {
        const result = await u.use((c) => c.readResource(params));
        uriOwner.set(params.uri, u);
        return result;
      } catch (err) {
        failure = err;
      }
    }
    throw failure ?? new ProtocolError(INVALID_PARAMS, `no upstream for ${params.uri}`);
  });

  return server;
}

const handler = createMcpHandler(createServer);

function reload() {
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  for (const [name, u] of upstreams) {
    if (!(name in config)) {
      u.close();
      upstreams.delete(name);
    }
  }
  for (const [name, cfg] of Object.entries(config)) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad upstream name: ${name}`);
    if (!upstreams.has(name)) upstreams.set(name, new Upstream(name, cfg));
  }
  changed();
}

reload();
let debounce;
watch(dirname(CONFIG), (_event, file) => {
  if (file !== basename(CONFIG)) return;
  clearTimeout(debounce);
  debounce = setTimeout(reload, 100);
});

const app = createMcpHonoApp();
app.all('/mcp', (c) => {
  if (TOKEN && c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.text('unauthorized', 401);
  return handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') });
});
const http = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => console.error(`baseline gateway ${i.port} pid=${process.pid}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await Promise.allSettled([...upstreams.values()].map((u) => u.close()));
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
