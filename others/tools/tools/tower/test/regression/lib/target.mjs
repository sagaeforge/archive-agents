// The gateway under test. TOWER_TEST_TARGET=tower (default) runs tools/tower/dist/server.js, =spike runs the S1 baseline gateway.
// Scenarios describe upstreams in tower.json shape; this file renders that for each target and starts the process.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE, P } from '../harness/env.mjs';
import { connectFetch, jsonBody, rawRequest, waitPort } from './http.mjs';
import { open } from './mcp.mjs';
import { spawnTracked } from './proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REGRESSION = resolve(here, '..');
export const REPO = resolve(REGRESSION, '../../../..');
export const SPIKE_GATEWAY = join(REPO, 'docs/research/spikes/s1-aggregation/c5-baseline/gateway.mjs');
export const TOWER_SERVER = process.env.TOWER_TEST_SERVER ?? join(REPO, 'tools/tower/dist/server.js');
export const GEN_DIR = join(REGRESSION, '.gen');

export const TARGET = process.env.TOWER_TEST_TARGET ?? 'tower';
if (!['spike', 'tower'].includes(TARGET)) throw new Error(`TOWER_TEST_TARGET must be spike or tower, got ${TARGET}`);

export function targetReady() {
  if (TARGET === 'spike') return existsSync(SPIKE_GATEWAY) ? null : `spike gateway missing: ${SPIKE_GATEWAY}`;
  return existsSync(TOWER_SERVER) ? null : `tower is not built: ${TOWER_SERVER} is missing (run npm run build -w tools/tower)`;
}

// The S1 gateway reads a flat { name: {url} | {command,args,env,cwd} } file and nothing else.
export function renderConfig(spec, target = TARGET) {
  if (target === 'tower') return JSON.stringify(spec, null, 2);
  const flat = {};
  for (const [name, u] of Object.entries(spec.upstreams ?? {})) {
    if (u.enabled === false) continue;
    flat[name] = u.url ? { url: u.url } : { command: u.command, args: u.args, ...(u.env ? { env: u.env } : {}), ...(u.cwd ? { cwd: u.cwd } : {}) };
  }
  return JSON.stringify(flat, null, 2);
}

// The S1 gateway listens on GW_PORT. systemd socket activation needs fd 3, so the review ran a copy that changed only the listen lines.
export function spikeSocketCopy() {
  const out = join(GEN_DIR, 'spike-gateway-fd.mjs');
  mkdirSync(GEN_DIR, { recursive: true });
  const src = readFileSync(SPIKE_GATEWAY, 'utf8');
  const from = src.indexOf('const http = serve(');
  const to = src.indexOf('\n', from);
  if (from < 0) throw new Error('spike gateway listen line not found');
  const listen = `import { createAdaptorServer } from '@hono/node-server';
const http = createAdaptorServer({ fetch: app.fetch });
const onListen = () => console.error('baseline gateway (fd) pid=' + process.pid);
if (process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid) http.listen({ fd: 3 }, onListen);
else http.listen(PORT, '127.0.0.1', onListen);`;
  writeFileSync(out, src.slice(0, from) + listen + src.slice(to));
  return out;
}

// A copy of dist with constants changed, for limits too long to wait out. Under .gen so its packages still resolve. Only tower has one.
export function patchedServer(name, edits) {
  const out = join(GEN_DIR, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let applied = 0;
  for (const file of readdirSync(dirname(TOWER_SERVER)).filter((f) => f.endsWith('.js'))) {
    let text = readFileSync(join(dirname(TOWER_SERVER), file), 'utf8');
    for (const [from, to] of edits) if (text.includes(from)) { text = text.replaceAll(from, to); applied += 1; }
    writeFileSync(join(out, file), text);
  }
  if (applied !== edits.length) throw new Error(`${name}: ${edits.length - applied} of the edits matched nothing in dist`);
  return join(out, 'server.js');
}

// tokenMode: 'ok' (random 64 hex), 'none' (no token anywhere), 'short' (too short to be accepted)
export function createGateway({ tmp, spec, tokenMode = 'ok', env = {}, port = P.gw, name = 'gw', server = TOWER_SERVER }) {
  const home = join(tmp, `${name}-home`);
  const cfgDir = TARGET === 'tower' ? join(home, '.config/tower') : join(tmp, `${name}-cfg`);
  const cfgPath = join(cfgDir, TARGET === 'tower' ? 'tower.json' : 'upstreams.json');
  const logPath = join(tmp, `${name}.log`);
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(join(home, '.local/state/tower'), { recursive: true, mode: 0o700 });
  const token = tokenMode === 'ok' ? randomBytes(32).toString('hex') : tokenMode === 'short' ? 'abc' : null;
  if (TARGET === 'tower' && token) writeFileSync(join(cfgDir, 'token'), token, { mode: 0o600 });
  const base = `http://127.0.0.1:${port}`;
  const h = {
    target: TARGET, port, base, url: `${base}/mcp`, token, home, cfgPath, logPath, proc: null, tmp,
    lastGoodPath: join(home, '.local/state/tower/last-good.json'),
    envFor(extra = {}) {
      if (TARGET === 'spike') return { GW_CONFIG: cfgPath, GW_PORT: String(port), ...(token ? { GW_TOKEN: token } : {}), ...env, ...extra };
      return { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), TOWER_CONFIG: cfgPath, TOWER_PORT: String(port), ...env, ...extra };
    },
    commandFor(extra = {}) { return { cmd: NODE, args: [TARGET === 'spike' ? SPIKE_GATEWAY : server], env: h.envFor(extra) }; },
    writeConfig(s) { h.writeRaw(renderConfig(s), true); },
    // atomic=false is a plain truncate-and-write, like an editor saving a half-typed file
    writeRaw(text, atomic = false) {
      if (atomic) { const t = `${cfgPath}.tmp`; writeFileSync(t, text); renameSync(t, cfgPath); } else writeFileSync(cfgPath, text);
    },
    // wait=false returns as soon as the process is spawned (for scenarios that probe the first moments)
    async start({ wait = true, extraEnv = {}, timeoutMs = 15000 } = {}) {
      const c = h.commandFor(extraEnv);
      h.proc = spawnTracked(c.cmd, c.args, { env: c.env, cwd: tmp, log: logPath });
      if (wait) {
        const up = await Promise.race([waitPort(port, timeoutMs), h.proc.exited.then(() => false)]);
        if (!up) throw new Error(`gateway did not open port ${port} (exit=${JSON.stringify(h.proc.exitInfo())}) log=${h.logTail()}`);
      }
      return h;
    },
    async stop(graceMs) { return h.proc ? h.proc.stop(graceMs) : 0; },
    kill(sig = 'SIGKILL') { return h.proc?.signalLeader(sig); },
    alive() { return !!h.proc && !h.proc.exitInfo(); },
    logTail(n = 300) { return h.proc ? h.proc.readLog().slice(-n).replace(/\s+/g, ' ') : ''; },
    logLines() { return h.proc ? h.proc.readLog().split('\n').filter(Boolean) : []; },
    // tower writes one JSON object per line; anything else (the spike prints plain text) is ignored
    events(kind = 'event') {
      return h.logLines().flatMap((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' && (!kind || o.kind === kind) ? [o] : []; } catch { return []; } });
    },
    async open(era, timeoutMs) { return open(h.url, era, h.token ?? undefined, timeoutMs); },
    async healthz() {
      const r = await rawRequest({ port, path: '/healthz', timeoutMs: 3000 });
      return r.status === 200 ? { status: 200, json: jsonBody(r) } : { status: r.status, json: null };
    },
    async adminStatus() {
      if (!token) return null;
      const r = await rawRequest({ port, path: '/admin/status', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 3000 });
      return r.status === 200 ? jsonBody(r) : null;
    },
    async get(path, headers = {}) { return connectFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000) }); },
  };
  if (TARGET === 'tower' || spec) h.writeConfig(spec ?? { upstreams: {}, routes: {} });
  return h;
}

// /admin/status is whatever the implementer chose. Accept an object keyed by name or an array of { name }.
export function upstreamStatus(status, name) {
  const u = status?.upstreams;
  if (!u) return null;
  if (Array.isArray(u)) return u.find((x) => x.name === name) ?? null;
  return u[name] ?? null;
}
export const warningsText = (status) => JSON.stringify(status?.warnings ?? []);
