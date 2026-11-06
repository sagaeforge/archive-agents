// Cold start, idle memory and call latency, measured the same way for every candidate.
// usage: bench.mjs <outfile> [N]
// Cold start = exec to first merged tools/list holding all 4 tools, polled every 2 ms, alpha already up.
import { ROOT as TT_ROOT, P as TT_P } from './env.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { open, pick } from './lib.mjs';

const S = `${TT_ROOT}`;
const [outfile, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const candidates = [
  { name: 'agentgateway', port: TT_P.third, bearer: 's1-spike-throwaway-key', cwd: `${S}/c1-agentgateway`, cmd: ['./bin/agentgateway-linux-amd64', '-f', 'cfg-fm-failOpen_beta.mjs.yaml'] },
  { name: 'fastmcp-ts', port: TT_P.origin, cwd: `${S}/c2-fastmcp`, cmd: ['node', 'gateway.mjs'] },
  { name: 'mcp-use', port: TT_P.evil, cwd: `${S}/c3-mcpuse`, cmd: ['node', 'gateway.mjs'], env: { MCP_USE_ANONYMIZED_TELEMETRY: 'false' } },
  { name: '1mcp', port: TT_P.never, cwd: `${S}/c4-1mcp`, cmd: ['./run.sh'] },
  { name: 'baseline', port: TT_P.gw, cwd: `${S}/c5-baseline`, cmd: ['node', 'gateway.mjs'] },
];

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stats = (a) => ({ n: a.length, p50: +pct(a, 0.5).toFixed(1), p95: +pct(a, 0.95).toFixed(1), min: +Math.min(...a).toFixed(1), max: +Math.max(...a).toFixed(1) });
const tryConnect = (port) => new Promise((resolve) => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
function start(c) {
  return spawn(c.cmd[0], c.cmd.slice(1), { cwd: c.cwd, detached: true, stdio: 'ignore', env: { ...process.env, ...c.env } });
}
async function stop(p) {
  const gone = new Promise((r) => p.once('exit', r));
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000);
  await gone;
  clearTimeout(t);
  await sleep(120);
  try { process.kill(-p.pid, 'SIGKILL'); } catch {}
}
async function ready(c) {
  const url = `http://127.0.0.1:${c.port}/mcp`;
  for (let i = 0; i < 6000; i++) {
    if (await tryConnect(c.port)) break;
    await sleep(2);
  }
  const portAt = performance.now();
  for (let i = 0; i < 4000; i++) {
    const s = await open(url, 'legacy', c.bearer);
    if (s.negotiated) {
      const l = await s.call('tools/list');
      if ((l.json?.result?.tools?.length ?? 0) >= 4) return { portAt, readyAt: performance.now(), s, tools: l.json.result.tools };
    }
    await sleep(5);
  }
  throw new Error(`${c.name} never became ready`);
}
function tree(root) {
  const out = execFileSync('bash', ['-c', `collect(){ echo $1; for c in $(pgrep -P $1); do collect $c; done; }; collect ${root}`]).toString().trim().split('\n').map(Number);
  return out.flatMap((pid) => {
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8');
      const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return [{ pid, rssKb: Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0), pssKb: Number(/Pss:\s+(\d+)/.exec(roll)?.[1] ?? 0), threads: Number(/Threads:\s+(\d+)/.exec(st)?.[1] ?? 0), cmd: cmd.slice(0, 70) }];
    } catch { return []; }
  });
}
// A shell wrapper is not memory the gateway needs, so skip those rows.
const real = (rows) => rows.filter((r) => !/^(bash|sh|\/bin\/bash)\b/.test(r.cmd));

const report = { env: { node: process.version, cpus: execFileSync('nproc').toString().trim(), load: readFileSync('/proc/loadavg', 'utf8').trim() }, candidates: {} };
for (const c of candidates) {
  const r = { name: c.name };
  report.candidates[c.name] = r;
  const portT = [];
  const readyT = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const p = start(c);
    const { portAt, readyAt } = await ready(c);
    portT.push(portAt - t0);
    readyT.push(readyAt - t0);
    await stop(p);
  }
  r.coldPortMs = stats(portT);
  r.coldReadyMs = stats(readyT);

  const mem = [];
  for (let i = 0; i < 3; i++) {
    const p = start(c);
    await ready(c);
    const bootRows = real(tree(p.pid));
    const url = `http://127.0.0.1:${c.port}/mcp`;
    const s = await open(url, 'legacy', c.bearer);
    const m = await open(url, 'modern', c.bearer);
    const l = await s.call('tools/list');
    const { a, b } = pick(l.json.result.tools);
    for (const se of [s, m]) {
      await se.call('tools/call', { name: a, arguments: {} });
      await se.call('tools/call', { name: b, arguments: { text: 'x' } });
    }
    await sleep(20000);
    const rows = real(tree(p.pid));
    mem.push({
      afterBootGatewayRssMb: +(bootRows[0].rssKb / 1024).toFixed(1),
      idleGatewayRssMb: +(rows[0].rssKb / 1024).toFixed(1),
      idleGatewayPssMb: +(rows[0].pssKb / 1024).toFixed(1),
      idleTreeRssMb: +(rows.reduce((x, y) => x + y.rssKb, 0) / 1024).toFixed(1),
      idleTreePssMb: +(rows.reduce((x, y) => x + y.pssKb, 0) / 1024).toFixed(1),
      procs: rows.length,
      threads: rows[0].threads,
    });
    await stop(p);
  }
  r.memory = mem;

  const p = start(c);
  await ready(c);
  const url = `http://127.0.0.1:${c.port}/mcp`;
  const lat = {};
  for (const era of ['legacy', 'modern']) {
    const s = await open(url, era, c.bearer);
    const l = await s.call('tools/list');
    const { a, b } = pick(l.json.result.tools);
    for (const [tag, name, args] of [['alpha', a, {}], ['beta', b, { text: 'x' }]]) {
      const samples = [];
      const reps = c.name === 'agentgateway' && era === 'modern' ? 60 : 200;
      for (let i = 0; i < reps; i++) {
        const res = await s.call('tools/call', { name, arguments: args });
        if (res.json?.result && !res.json.result.isError) samples.push(res.ms);
      }
      lat[`${era}.${tag}`] = samples.length ? stats(samples) : 'all failed';
    }
  }
  r.latencyMs = lat;
  await stop(p);
  console.log(c.name, JSON.stringify({ cold: r.coldReadyMs, port: r.coldPortMs }), JSON.stringify(r.memory.at(-1)));
  writeFileSync(outfile, JSON.stringify(report, null, 1));
}

// Control: alpha directly, no gateway.
const s = await open(`http://127.0.0.1:${TT_P.alpha}/mcp`, 'modern');
const samples = [];
for (let i = 0; i < 200; i++) samples.push((await s.call('tools/call', { name: 'status', arguments: {} })).ms);
report.controlDirectAlphaMs = stats(samples);
writeFileSync(outfile, JSON.stringify(report, null, 1));
console.log('control', JSON.stringify(report.controlDirectAlphaMs));
process.exit(0);
