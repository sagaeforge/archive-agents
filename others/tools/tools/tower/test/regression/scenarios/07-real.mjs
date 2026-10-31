// Extra rows (section 10 "실제 서버"): real SDK servers instead of the S1 stand-ins, which all shared one parser.
// Python SDK 1.30.0 (the version the design names), Python SDK 2.3.0 (the current 2.x line),
// and a TypeScript SDK v1 1.30.0 server.
import { join } from 'node:path';
import { P } from '../harness/env.mjs';
import { alphaCfg, PY1, PY2, realPyCfg, realTsCfg, spawnCount } from '../lib/fixtures.mjs';
import { fullList, textOf } from '../lib/helpers.mjs';
import { callTool, isOk } from '../lib/mcp.mjs';
import { median, sleep } from '../lib/util.mjs';

function realServerScenario(order, id, title, makeCfg) {
  return {
    order, row: `x${order - 26}`, id, title, timeoutMs: 90000,
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const log = join(ctx.tmp, 'real.log');
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), real: makeCfg(log) } });
      await g.start();
      const names = await fullList(g, 4, 15000);
      ctx.check('real_status and real_echo are listed (4 tools)', names.includes('real_status') && names.includes('real_echo'), names.join(','));
      const lat = [];
      for (const era of ['modern', 'legacy']) {
        const s = await g.open(era, 15000);
        const r = await callTool(s, 'real_echo', { text: 'hi' }, 15000);
        ctx.check(`${era}: real_echo returns the echo`, isOk(r) && /echo/.test(textOf(r)) && /hi/.test(textOf(r)), textOf(r).slice(0, 60) || `${r.status} ${r.raw ?? ''}`);
        const st = await callTool(s, 'real_status', {}, 15000);
        ctx.check(`${era}: real_status works`, isOk(st), textOf(st).slice(0, 60));
        for (let i = 0; i < 20; i++) lat.push((await callTool(s, 'real_echo', { text: 'x' }, 15000)).ms);
      }
      await sleep(300);
      ctx.metric('callP50Ms', median(lat));
      ctx.check('one stdio child for all 42 calls (spawn count 1)', spawnCount(log) === 1, `spawns=${spawnCount(log)}`);
      ctx.check('call p50 under 50 ms', median(lat) < 50, `${median(lat)} ms`);
      ctx.docResult('one child, 2-4 ms per call [R]', spawnCount(log) === 1 && median(lat) < 50, `spawns=${spawnCount(log)} p50=${median(lat)} ms`);
    },
  };
}

export const scenarios = [
  realServerScenario(27, 'real-py-1.30.0', 'real Python SDK mcp 1.30.0 (FastMCP) through the merge', (log) => realPyCfg(PY1, log)),
  realServerScenario(28, 'real-py-2.3.0', 'real Python SDK mcp 2.3.0 (MCPServer, the current 2.x line) through the merge', (log) => realPyCfg(PY2, log)),
  realServerScenario(29, 'real-ts-v1-1.30.0', 'real TypeScript SDK v1 1.30.0 server through the merge', (log) => realTsCfg(log)),
];
