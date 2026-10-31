// Stand-in for an external stdio MCP server (the proxmox plugin is not run).
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
serveStdio(() => { const s = new McpServer({ name: 'standin', version: '0.0.1' });
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) s.registerTool(n, { description: 'x', inputSchema: z.object({ q: z.string().optional() }) }, async () => ({ content: [{ type: 'text', text: n }] }));
  return s; });
