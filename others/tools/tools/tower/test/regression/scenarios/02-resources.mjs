// Section 10 rows 4-6: resource URI ownership.
import { join } from 'node:path';
import { P } from '../harness/env.mjs';
import { alphaCfg, betaCfg } from '../lib/fixtures.mjs';
import { fullList, textOf } from '../lib/helpers.mjs';
import { upstreamStatus, warningsText } from '../lib/target.mjs';
import { sleep, waitFor } from '../lib/util.mjs';

const URI = 'doc://alpha/snapshot/1';
const ONLY_TWO = 'doc://alpha/only-two';
const bodyOf = (r) => r.json?.result?.contents?.map((c) => c.text).join('|') ?? '';
const errOf = (r) => (r.json?.error ? JSON.stringify(r.json.error) : r.json?.result?.isError ? textOf(r) : r.status === 0 ? `transport ${r.raw}` : '');

// Two HTTP servers exposing the same URI (doc://alpha/snapshot/1). Which one answers is visible in the body: it carries the pid.
// The second also has a URI of its own, and one inside the first one's prefix that only it can answer: the body a fallback would reach.
async function twoServers(ctx) {
  const one = await ctx.http('alpha', P.alpha, { ALPHA_NAME: 'one' }, 'one');
  const two = await ctx.http('alpha', P.gamma, { ALPHA_NAME: 'two', ALPHA_MORE_URIS: `doc://two/snapshot/1,${ONLY_TWO}` }, 'two');
  const spec = { upstreams: { one: alphaCfg(P.alpha, { uriPrefixes: ['doc://alpha/'] }), two: alphaCfg(P.gamma, { uriPrefixes: ['doc://two/'] }) } };
  return { one, two, spec };
}

export const scenarios = [
  {
    order: 4, row: 4, id: 'dup-uri', timeoutMs: 60000,
    title: 'same URI from two upstreams: only the prefix owner is exposed, others warn',
    async run(ctx) {
      const { one, two, spec } = await twoServers(ctx);
      const g = ctx.gateway(spec);
      await g.start();
      const names = await fullList(g, 4);
      ctx.check('both upstreams listed (4 tools)', names.length === 4, names.join(','));
      const s = await g.open('modern');
      const bodies = [];
      let uris = [];
      for (let i = 0; i < 3; i++) {
        const l = await s.call('resources/list');
        uris = (l.json?.result?.resources ?? []).map((r) => r.uri);
        bodies.push(bodyOf(await s.call('resources/read', { uri: URI })));
        await sleep(100);
      }
      ctx.check('resources/list shows the URI once', uris.filter((u) => u === URI).length === 1, uris.join(','));
      ctx.check('every read is the owner\'s body', bodies.every((b) => b.includes(`from ${one.pid}`)), bodies.join(' || '));
      const own = await s.call('resources/read', { uri: 'doc://two/snapshot/1' });
      ctx.check('control: the other upstream still answers under its own prefix', bodyOf(own).includes(`from ${two.pid}`), errOf(own) || bodyOf(own));
      const other = await s.call('resources/read', { uri: ONLY_TWO });
      ctx.check('read of a URI only the non-owner holds is an error with no body', !bodyOf(other) && !!errOf(other), errOf(other) || bodyOf(other));
      const st = await g.adminStatus();
      ctx.check('out-of-prefix resource reported in warnings (names "two")', /\btwo\b/.test(warningsText(st)), st ? warningsText(st).slice(0, 120) : 'no /admin/status');
      ctx.docResult('read returns a different upstream\'s body (last lister wins)', bodies.some((b) => !b.includes(`from ${one.pid}`)), `bodies=${bodies.map((b) => (b.includes(`from ${one.pid}`) ? 'one' : b.includes(`from ${two.pid}`) ? 'two' : '?')).join(',')} listed=${uris.length}x`);
    },
  },
  {
    order: 5, row: 5, id: 'owner-down-restart', timeoutMs: 90000,
    title: 'owner down while the gateway restarts: error naming the owner, no other body',
    async run(ctx) {
      const { one, two, spec } = await twoServers(ctx);
      const g = ctx.gateway(spec);
      await g.start();
      await fullList(g, 4);
      await one.stop();
      await g.stop();
      await g.start();
      const visible = await waitFor(async () => (await fullList(g, 2, 2000)).some((n) => n.startsWith('two_')), 10000, 200);
      ctx.check('gateway is up with the second upstream visible', !!visible);
      const s = await g.open('modern', 20000);
      const r = await s.call('resources/read', { uri: URI }, 20000);
      const body = bodyOf(r);
      ctx.check('no body from the other upstream', !body.includes(`from ${two.pid}`) && !body, body);
      ctx.check('an error comes back', !!errOf(r), `${r.status} ${errOf(r)}`);
      ctx.check('the error names the owner "one"', /\bone\b/.test(errOf(r)), errOf(r));
      ctx.docResult('a different upstream\'s body is returned', body.includes(`from ${two.pid}`), body ? `body from ${body.includes(`from ${two.pid}`) ? 'two' : 'other'}` : `no body: ${errOf(r)}`);
    },
  },
  {
    order: 6, row: 6, id: 'no-prefix', timeoutMs: 60000,
    title: 'upstream without uriPrefixes that serves resources: exposed 0, warnings',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const betaLog = join(ctx.tmp, 'beta.log');
      const g = ctx.gateway({ upstreams: { alpha: { url: `http://127.0.0.1:${P.alpha}/mcp` }, beta: betaCfg(betaLog) } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      const uris = (await s.call('resources/list')).json?.result?.resources?.map((r) => r.uri) ?? [];
      ctx.check('control: the prefixed upstream\'s resource is listed', uris.includes('beta://notes/1'), uris.join(','));
      ctx.check('no resource of the prefix-less upstream is exposed', !uris.includes(URI), uris.join(','));
      const r = await s.call('resources/read', { uri: URI });
      ctx.check('reading it is an error with no body', !bodyOf(r) && !!errOf(r), errOf(r) || bodyOf(r));
      const st = await g.adminStatus();
      ctx.check('warnings mention alpha', /alpha/.test(warningsText(st)), st ? warningsText(st).slice(0, 120) : 'no /admin/status');
      ctx.docResult('resource is exposed', uris.includes(URI), `listed=${uris.join(',')}`);
    },
  },
];
void upstreamStatus;
