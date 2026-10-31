import { serve } from '@hono/node-server';
import { Hono } from 'hono';
const a = new Hono(); a.get('/', (c) => c.text('via serve() fd hack\n'));
const s = serve({ fetch: a.fetch, port: { fd: 3 } }, (i) => console.log('info', JSON.stringify(i)));
setTimeout(() => s.close(() => process.exit(0)), 1500);
