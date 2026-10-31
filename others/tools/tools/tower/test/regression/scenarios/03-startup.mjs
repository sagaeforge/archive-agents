// Section 10 rows 7-9: what the first tools/list returns right after the port opens.
import { join } from 'node:path';
import { P } from '../harness/env.mjs';
import { alphaCfg, betaCfg, PY1, realPyCfg, slowPyCfg } from '../lib/fixtures.mjs';
import { portOpen } from '../lib/http.mjs';
import { listen, toolNames } from '../lib/mcp.mjs';
import { ms, now, sleep, waitFor } from '../lib/util.mjs';

// What a real client does: wait for the port, then discover and list without pausing (firstlist.mjs from the review).
async function firstListTrials(ctx, spec, want, n) {
  const g = ctx.gateway(spec);
  const hist = {};
  const full = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await g.start({ wait: false });
    while (!(await portOpen(g.port, '127.0.0.1', 40))) { if (g.proc.exitInfo()) break; if (now() - t0 > 8000) break; await sleep(1); }
    let count = -1;
    if (!g.proc.exitInfo()) {
      const s = await g.open('modern', 5000);
      const r = await s.call('tools/list', {}, 5000);
      count = toolNames(r)?.length ?? -1;
      full.push(count);
    }
    hist[count] = (hist[count] ?? 0) + 1;
    await g.stop(2000);
    await sleep(60);
  }
  return { hist, fullCount: full.filter((c) => c >= want).length, n };
}

export const scenarios = [
  {
    order: 7, row: 7, id: 'first-list', timeoutMs: 150000,
    title: 'tools/list right after the port opens is complete, 20/20 (S1 beta and real Python)',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const N = Number(process.env.TOWER_TEST_FIRSTLIST_N ?? 20);
      const betaSpec = { upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } };
      const pySpec = { upstreams: { alpha: alphaCfg(), real: realPyCfg(PY1, join(ctx.tmp, 'py.log')) } };
      const a = await firstListTrials(ctx, betaSpec, 4, N);
      const b = await firstListTrials(ctx, pySpec, 4, N);
      ctx.metric('s1-beta.histogram', a.hist);
      ctx.metric('real-python.histogram', b.hist);
      ctx.check(`S1 beta: ${N}/${N} first lists have all 4 tools`, a.fullCount === N, `full ${a.fullCount}/${N} sizes=${JSON.stringify(a.hist)}`);
      ctx.check(`real Python: ${N}/${N} first lists have all 4 tools`, b.fullCount === N, `full ${b.fullCount}/${N} sizes=${JSON.stringify(b.hist)}`);
      const partial = (r) => r.n - r.fullCount;
      ctx.docResult('20/20 partial', partial(a) >= N - 2 && partial(b) >= N - 2, `partial: beta ${partial(a)}/${N}, python ${partial(b)}/${N}`);
    },
  },
  {
    order: 8, row: 8, id: 'slow-stdio', timeoutMs: 60000,
    title: '3 s stdio upstream: the first list is complete',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const spec = { upstreams: { alpha: alphaCfg(), real: realPyCfg(PY1, join(ctx.tmp, 'py.log')), slow: slowPyCfg(PY1, 3) } };
      const g = ctx.gateway(spec);
      await g.start();
      const s = await g.open('modern', 15000);
      const L = listen(g.url, s, g.token ?? undefined);
      const t0 = now();
      const first = toolNames(await s.call('tools/list', {}, 15000)) ?? [];
      const firstMs = ms(t0);
      ctx.metric('firstListSize', first.length);
      ctx.metric('firstListMs', firstMs);
      ctx.check('first list has all 5 tools', first.length === 5, `${first.length} tools in ${firstMs} ms: ${first.join(',')}`);
      let finalSize = first.length;
      if (first.length < 5) finalSize = await waitFor(async () => { const n = toolNames(await s.call('tools/list', {}, 5000))?.length ?? 0; return n >= 5 ? n : null; }, 8000, 200) ?? finalSize;
      await sleep(300);
      const changed = L.seen.filter((e) => e.method === 'notifications/tools/list_changed').length;
      L.close();
      ctx.docResult('first list 2/5, then a list_changed notification', first.length < 5 && changed >= 1 && finalSize >= 5, `first=${first.length}/5 in ${firstMs} ms, list_changed seen=${changed}, later=${finalSize}/5`);
    },
  },
  {
    order: 9, row: 9, id: 'connectwait', timeoutMs: 60000,
    title: 'upstream slower than connectWaitMs: partial list, list_partial, list_changed on arrival',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const spec = { upstreams: { alpha: alphaCfg(), slow: slowPyCfg(PY1, 7) } };
      const g = ctx.gateway(spec);
      await g.start();
      const s = await g.open('modern', 15000);
      const L = listen(g.url, s, g.token ?? undefined);
      const t0 = now();
      const first = toolNames(await s.call('tools/list', {}, 15000)) ?? [];
      const firstMs = ms(t0);
      ctx.metric('firstListMs', firstMs);
      ctx.check('the list answers within the bounded wait (<= 5.5 s)', firstMs <= 5500, `${firstMs} ms`);
      ctx.check('it is partial: alpha present, slow upstream absent', first.some((n) => n.startsWith('alpha_')) && !first.some((n) => n.startsWith('slow_')), first.join(','));
      const ev = g.events().find((e) => e.event === 'list_partial');
      ctx.check('list_partial event names the late upstream', !!ev && JSON.stringify(ev).includes('slow'), ev ? JSON.stringify(ev).slice(0, 120) : 'no event');
      const arrived = await waitFor(async () => L.seen.some((e) => e.method === 'notifications/tools/list_changed' && e.at > L.startedAt + 3000) || null, 12000, 200);
      ctx.check('list_changed is sent when the late upstream arrives', !!arrived, `seen=${L.seen.map((e) => e.method).join(',')}`);
      const later = toolNames(await s.call('tools/list', {}, 10000)) ?? [];
      ctx.check('the next list includes the late upstream', later.some((n) => n.startsWith('slow_')), later.join(','));
      L.close();
      ctx.docResult('no spike result in the table', null, `first=${first.length} tools in ${firstMs} ms; list_changed ${arrived ? 'arrived' : 'missing'}`);
    },
  },
];
