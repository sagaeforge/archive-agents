// Cold start with a bounded connect attempt, keeping every raw sample.
import { ROOT as TT_ROOT, P as TT_P } from './env.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { open } from './lib.mjs';
const S = `${TT_ROOT}`;
const N = Number(process.argv[2] ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cands = [
  { name: 'agentgateway', port: TT_P.third, bearer: 's1-spike-throwaway-key', cwd: `${S}/c1-agentgateway`, cmd: ['./bin/agentgateway-linux-amd64', '-f', 'cfg-fm-failOpen_beta.mjs.yaml'] },
  { name: 'fastmcp-ts', port: TT_P.origin, cwd: `${S}/c2-fastmcp`, cmd: ['node', 'gateway.mjs'] },
  { name: 'mcp-use', port: TT_P.evil, cwd: `${S}/c3-mcpuse`, cmd: ['node', 'gateway.mjs'], env: { MCP_USE_ANONYMIZED_TELEMETRY: 'false' } },
  { name: '1mcp', port: TT_P.never, cwd: `${S}/c4-1mcp`, cmd: ['./run.sh'] },
  { name: 'baseline', port: TT_P.gw, cwd: `${S}/c5-baseline`, cmd: ['node', 'gateway.mjs'] },
];
const attempt = (port) => new Promise((resolve) => {
  const s = connect(port, '127.0.0.1');
  const t = setTimeout(() => { s.destroy(); resolve(false); }, 40);
  s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
  s.once('error', () => { clearTimeout(t); resolve(false); });
});
const out = {};
for (const c of cands) {
  const port = []; const ready = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const p = spawn(c.cmd[0], c.cmd.slice(1), { cwd: c.cwd, detached: true, stdio: 'ignore', env: { ...process.env, ...c.env } });
    while (!(await attempt(c.port))) await sleep(1);
    port.push(+(performance.now() - t0).toFixed(1));
    for (;;) {
      const s = await open(`http://127.0.0.1:${c.port}/mcp`, 'legacy', c.bearer);
      if (s.negotiated) {
        const l = await s.call('tools/list');
        if ((l.json?.result?.tools?.length ?? 0) >= 4) break;
      }
      await sleep(3);
    }
    ready.push(+(performance.now() - t0).toFixed(1));
    const gone = new Promise((r) => p.once('exit', r));
    process.kill(-p.pid, 'SIGTERM');
    const kill = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000);
    await gone; clearTimeout(kill);
    await sleep(150);
    try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  }
  const s = (a) => { const b = [...a].sort((x, y) => x - y); return { p50: b[Math.floor(b.length / 2)], p90: b[Math.floor(b.length * 0.9)], max: b.at(-1), min: b[0] }; };
  out[c.name] = { port, ready };
  console.log(c.name.padEnd(13), 'port', JSON.stringify(s(port)), 'ready', JSON.stringify(s(ready)));
}
writeFileSync(`${S}/results/cold2.json`, JSON.stringify(out));
process.exit(0);
