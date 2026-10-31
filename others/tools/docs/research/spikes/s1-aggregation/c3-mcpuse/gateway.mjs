// mcp-use server.proxy(): HTTP upstream through the config map, stdio through an MCPConnection.
import { MCPClient } from '@mcp-use/client';
import { MCPServer } from 'mcp-use';

const PORT = Number(process.env.GW_PORT ?? 18130);
const server = new MCPServer({ name: 'gateway', version: '1.0.0', host: '127.0.0.1' });
const stdio = new MCPClient({ mcpServers: { beta: { command: process.execPath, args: ['/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/upstreams/' + (process.env.BETA ?? 'beta.mjs')] } } });
const beta = await stdio.connect('beta');
await server.proxy({ alpha: { url: 'http://127.0.0.1:18101/mcp' } });
await server.proxy(beta);
await server.listen(PORT);
