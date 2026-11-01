// Host, Origin and Fetch Metadata on every server (design 11): the built app on 4819, the Vite dev server on 4816, `relief serve` on 4822.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { PORT } from './support/ports.ts';

// fetch() will not let a script set Host, so these go through node:http.
const raw = (port: number, path: string, headers: Record<string, string>, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
  req.on('error', reject); req.end();
});

// `relief serve` runs with no tower here, so its map holds the WAN box alone.
for (const [name, port, objects] of [['built', PORT.built, 16], ['dev', PORT.dev, 16], ['serve', PORT.serve, 1]] as const) {
  test.describe(name, () => {
    test('serves a snapshot to a local Host', async () => {
      const r = await raw(port, '/api/snapshot', { host: `127.0.0.1:${port}` });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).nodes.length).toBe(objects);
    });
    test('a foreign Host is refused, on the API and on the page', async () => {
      for (const p of ['/api/snapshot', '/']) expect((await raw(port, p, { host: 'evil.example.com' })).status, p).toBe(403);
    });
    test('a foreign Origin is refused', async () => {
      expect((await raw(port, '/api/snapshot', { host: `127.0.0.1:${port}`, origin: 'http://evil.example.com' })).status).toBe(403);
      expect((await raw(port, '/api/snapshot', { host: `127.0.0.1:${port}`, origin: 'null' })).status).toBe(403);
    });
    test('a cross-site fetch is refused', async () => {
      expect((await raw(port, '/api/snapshot', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).status).toBe(403);
    });
    test('no write verb answers', async () => {
      for (const m of ['POST', 'PUT', 'DELETE']) expect((await raw(port, '/api/snapshot', { host: `127.0.0.1:${port}` }, m)).status, m).toBe(404);
    });
  });
}

test('the servers listen on loopback only', async () => {
  // The same port on a non-loopback interface address must not answer. eth0 is the LAN address on this host (WSL mirrored networking).
  const { networkInterfaces } = await import('node:os');
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  test.skip(!lan, 'no non-loopback interface');
  for (const port of [PORT.built, PORT.dev, PORT.serve]) {
    const res = await new Promise<string>((resolve) => {
      const req = http.request({ host: lan!.address, port, path: '/', timeout: 800 }, () => resolve('answered'));
      req.on('error', () => resolve('refused')); req.on('timeout', () => { req.destroy(); resolve('timeout'); }); req.end();
    });
    expect(res, `${lan!.address}:${port}`).not.toBe('answered');
  }
});

for (const port of [PORT.built, PORT.serve]) test(`the page on ${port} carries a strict content security policy`, async ({ page }) => {
  const r = await page.goto(`http://127.0.0.1:${port}/`);
  const csp = r!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'"); expect(csp).toContain("script-src 'self'"); expect(csp).toContain("connect-src 'self'"); expect(csp).toContain("frame-ancestors 'none'");
  expect(r!.headers()['x-content-type-options']).toBe('nosniff');
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.waitForSelector('svg.scene g[data-id]');
  expect(violations).toEqual([]);
});
