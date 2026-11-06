// Stand-in for an older external stdio server: speaks only the 2025 handshake.
// Hand-wired McpServer + StdioServerTransport, no serveStdio era logic.
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.BETA_SPAWN_LOG ?? resolve(here, '../logs/beta-spawn.log');
const stamp = (ev) => { try { appendFileSync(LOG, `${JSON.stringify({ ev, pid: process.pid, ppid: process.ppid, t: Date.now() })}\n`); } catch {} };
stamp('spawn');
process.on('exit', () => stamp('exit'));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => process.exit(0));
const server = new McpServer({ name: 'beta', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: 'BETA_INSTRUCTIONS: use beta for notes.' });
server.registerTool('status', { description: 'BETA status, plain text, no outputSchema', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: `beta-status pid=${process.pid}` }] }));
server.registerTool('beta_echo', { description: 'BETA echoes text', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text: `beta-echo:${text} pid=${process.pid}` }] }));
server.registerResource('beta-notes', 'beta://notes/1', { title: 'Beta notes', mimeType: 'text/plain' }, async () => ({ contents: [{ uri: 'beta://notes/1', mimeType: 'text/plain', text: `beta-body from ${process.pid}` }] }));
await server.connect(new StdioServerTransport());
