// Stand-in stdio upstream added for the tower scenarios: a hand-wired Server that declares resources and implements
// no resources/templates/list, which is common for servers that do not use McpServer.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server({ name: 'lowlevel', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'ping', description: 'LOWLEVEL ping', inputSchema: { type: 'object', properties: {} } }] }));
server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pong' }] }));
server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: 'low://one', name: 'one', mimeType: 'text/plain' }] }));
server.setRequestHandler('resources/read', async ({ params }) => ({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'low-one-body' }] }));
await server.connect(new StdioServerTransport());
