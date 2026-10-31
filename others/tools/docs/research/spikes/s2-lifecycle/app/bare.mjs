// Hono + node-server only, no MCP SDK or Zod: baseline for import cost.
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
const a = new Hono();
a.get('/healthz', (c) => c.json({ ok: true, pid: process.pid, listen_ms: tL, up_ms: performance.now() }));
const s = createAdaptorServer({ fetch: a.fetch }); let tL = 0;
s.listen({ fd: 3 }, () => { tL = performance.now(); });
const IDLE = Number(process.env.IDLE_MS ?? 100); let t;
s.on('request', (q, r) => { clearTimeout(t); r.once('close', () => { t = setTimeout(() => s.close(() => process.exit(0)), IDLE); }); });
