// fastmcp-ts mount()/createProxy() behind Hono through fetch(Request).
import { serve } from '@hono/node-server';
import { FastMCP, createProxy } from '@prefecthq/fastmcp-ts/server';
import { Hono } from 'hono';

const PORT = Number(process.env.GW_PORT ?? 18121);
const gateway = new FastMCP({ name: 'gateway', instructions: 'GATEWAY_INSTRUCTIONS' });
const alpha = await createProxy({ type: 'http', url: 'http://127.0.0.1:18101/mcp' });
const beta = await createProxy({ type: 'stdio', command: process.execPath, args: ['/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/upstreams/' + (process.env.BETA ?? 'beta.mjs')] });
gateway.mount(alpha);
gateway.mount(beta);

const app = new Hono();
app.all('/mcp', (c) => gateway.fetch(c.req.raw));
serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => console.error('fastmcp gateway', i.port, process.pid));
