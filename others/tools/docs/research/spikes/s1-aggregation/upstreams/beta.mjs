// Stand-in upstream "beta": stdio, SDK v2, 2 tools + 1 resource.
// Tool `status` deliberately collides with alpha's `status`.
// Every spawn and exit is appended to a log so short-lived children are counted.
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.BETA_SPAWN_LOG ?? resolve(here, '../logs/beta-spawn.log');
const stamp = (ev) => {
  try {
    appendFileSync(LOG, `${JSON.stringify({ ev, pid: process.pid, ppid: process.ppid, t: Date.now() })}\n`);
  } catch {}
};
stamp('spawn');
process.on('exit', () => stamp('exit'));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => process.exit(0));

const URI = 'beta://notes/1';

serveStdio(() => {
  const server = new McpServer(
    { name: 'beta', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: 'BETA_INSTRUCTIONS: use beta for notes.',
    },
  );

  server.registerTool(
    'status',
    { description: 'BETA status, plain text, no outputSchema', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: `beta-status pid=${process.pid}` }] }),
  );

  server.registerTool(
    'beta_echo',
    { description: 'BETA echoes text', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text: `beta-echo:${text} pid=${process.pid}` }] }),
  );

  server.registerResource(
    'beta-notes',
    URI,
    { title: 'Beta notes', description: 'beta resource', mimeType: 'text/plain' },
    async () => ({ contents: [{ uri: URI, mimeType: 'text/plain', text: `beta-body from ${process.pid}` }] }),
  );
  return server;
});
