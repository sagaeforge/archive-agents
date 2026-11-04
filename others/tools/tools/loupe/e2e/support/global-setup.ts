// One kb-mock on a Unix socket and one loupe serve per fixture, so there is no TCP route to the mock. Stopped in the returned teardown.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { accessLog, authDir, PORT, RESEARCH, HOSTILE, SAMPLE, root, sock } from './ports.ts';
import { startMock, startServe, stop } from './procs.ts';
import { login, startIdp, writeAuthConfig } from './oidc.ts';

// vite is hoisted to the workspace root, so its bin is resolved rather than assumed under ./node_modules.
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
const fixture = (f: string) => `contract-sample/fixtures/${f}`;

export default async function globalSetup() {
  if (process.env.LOUPE_E2E_BUILD !== '0') execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'ignore' });
  for (const n of ['r', 'h', 'k']) rmSync(accessLog(n), { force: true });
  // The login harness (design v2 M0b): a test OpenID provider for every loupe serve, and one real login per server.
  rmSync(authDir, { recursive: true, force: true });
  writeAuthConfig(authDir);
  const idp = await startIdp(PORT.idp);
  const procs = [
    await startMock('r', fixture('kb-research.json')), await startServe('r', PORT.research),
    await startMock('h', fixture('kb-hostile.json')), await startServe('h', PORT.hostile),
    await startMock('k', fixture('kb.json')), await startServe('k', PORT.sample),
  ];
  // A page on another site, opened as http://127.0.0.1:<crossSite> while the app is on localhost: different sites to the browser.
  const other = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>other site</title><p>other site</p>'); });
  await new Promise<void>((r) => other.listen(PORT.crossSite, '127.0.0.1', r));
  // Workers read this; the support fixture puts each origin's session into sessionStorage before the app starts.
  const teardown = async () => {
    await idp.stop();
    await new Promise((r) => { other.close(r); other.closeAllConnections(); });
    await Promise.all(procs.map(stop));
    for (const n of ['r', 'h', 'k']) rmSync(sock(n), { force: true });
  };
  const sessions: Record<string, string> = {};
  try {
    for (const o of [RESEARCH, HOSTILE, SAMPLE]) sessions[o] = await login(o);
  } catch (e) { await teardown(); throw e; }
  process.env.LOUPE_E2E_SESSIONS = JSON.stringify(sessions);
  return teardown;
}
