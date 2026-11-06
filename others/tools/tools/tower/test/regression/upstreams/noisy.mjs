// Stand-in stdio upstream added for the tower scenarios: it prints what it was given on stderr, so redaction can be
// observed, and its instructions have a configurable length, so the 4,096-character budget can be observed.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const { NOISY_TOKEN, NOISY_LOG, NOISY_INSTRUCTIONS = '0' } = process.env;
if (NOISY_LOG) appendFileSync(NOISY_LOG, `${JSON.stringify({ ev: 'spawn', pid: process.pid })}\n`);
process.stderr.write(`noisy started with token ${NOISY_TOKEN} leaked=${process.env.TOWER_CONFIG ?? 'no'}\n`);
const instructions = 'I'.repeat(Number(NOISY_INSTRUCTIONS)) || undefined;
const server = new McpServer({ name: 'noisy', version: '1.0.0' }, { capabilities: { tools: {} }, ...(instructions && { instructions }) });
server.registerTool('whoami', { description: 'NOISY pid and token', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: `pid=${process.pid} token=${NOISY_TOKEN}` }] }));
await server.connect(new StdioServerTransport());
