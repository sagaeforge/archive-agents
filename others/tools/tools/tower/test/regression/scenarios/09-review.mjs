// Rows the review of the first build added. Each one fails on that build and pins what the review found. tower only.
import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { NODE, P } from '../harness/env.mjs';
import { alphaCfg, rawCfg, UPSTREAMS } from '../lib/fixtures.mjs';
import { fullList, textOf, toolNames } from '../lib/helpers.mjs';
import { jsonBody, rawRequest } from '../lib/http.mjs';
import { callTool, failed, isOk, listen } from '../lib/mcp.mjs';
import { startOrigin } from '../lib/origin.mjs';
import { startTransient, systemdAvailable } from '../lib/systemd.mjs';
import { patchedServer, REPO, TOWER_SERVER, upstreamStatus, warningsText } from '../lib/target.mjs';
import { ms, now, sleep, waitFor } from '../lib/util.mjs';

const run = promisify(execFile);
const CLI = join(dirname(TOWER_SERVER), 'cli.js');
const cli = (g, args) => run(NODE, [CLI, ...args], { env: { ...process.env, ...g.envFor() }, timeout: 8000 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
const status = async (g, name) => upstreamStatus(await g.adminStatus(), name);
const stateIs = (g, name, state) => waitFor(async () => { const u = await status(g, name); return u?.state === state ? u : null; }, 10000, 10);
const childLog = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const envFile = (g, text) => writeFileSync(join(dirname(g.cfgPath), 'env'), text, { mode: 0o600 });
const adminStatus = (g, token = g.token) => rawRequest({ port: g.port, path: '/admin/status', headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
const towerOnly = (scenario) => ({ ...scenario, async run(ctx) {
  if (ctx.target !== 'tower') { ctx.check('runs against tower only', true); return; }
  await scenario.run(ctx);
} });

const scenarios = [
  {
    order: 44, row: 'x18', id: 'token-unreadable', timeoutMs: 40000,
    title: 'a token that cannot be read closes /mcp and /admin, at runtime and at boot, and tower stays up',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { a: rawCfg() } });
      await g.start();
      await fullList(g, 4);
      const tokenFile = join(dirname(g.cfgPath), 'token');
      const closed = async (label) => {
        ctx.check(`${label}: /admin answers 503`, await waitFor(async () => (await adminStatus(g)) === 503, 3000, 50));
        ctx.check(`${label}: tower is alive`, g.alive(), JSON.stringify(g.proc.exitInfo()));
        const health = await g.healthz();
        ctx.check(`${label}: /healthz stays 200`, health.status === 200, String(health.status));
        const r = await g.open('modern', 3000);
        ctx.check(`${label}: /mcp answers 503`, r.discover?.status === 503, String(r.discover?.status));
      };
      chmodSync(tokenFile, 0o000);
      await closed('chmod 000');
      ctx.check('the reason is in the journal', g.events().some((e) => e.event === 'token_unreadable'));
      chmodSync(tokenFile, 0o600);
      ctx.check('readable again: back without a restart', await waitFor(async () => (await adminStatus(g)) === 200, 3000, 50));
      rmSync(tokenFile);
      mkdirSync(tokenFile);
      await closed('a directory named token');
      rmdirSync(tokenFile);
      writeFileSync(tokenFile, g.token, { mode: 0o600 });
      ctx.check('a file again: back without a restart', await waitFor(async () => (await adminStatus(g)) === 200, 3000, 50));
      await g.stop();
      chmodSync(tokenFile, 0o000);
      await g.start();
      await closed('at boot');
    },
  },
  {
    order: 45, row: 'x19', id: 'last-good-safety', timeoutMs: 30000,
    title: 'last-good: no symlink followed, 600 in a 700 directory, and a failed write is a warning, not a rejection',
    async run(ctx) {
      const spec = { upstreams: { a: rawCfg() } };
      const g = ctx.gateway(spec);
      const dir = dirname(g.lastGoodPath);
      const victim = join(ctx.tmp, 'victim.txt');
      writeFileSync(victim, 'USER FILE');
      symlinkSync(victim, `${g.lastGoodPath}.tmp`);
      chmodSync(dir, 0o755);
      await g.start();
      await fullList(g, 4);
      await sleep(200);
      ctx.check('a symlink at the old temp name is not followed', readFileSync(victim, 'utf8') === 'USER FILE', readFileSync(victim, 'utf8').slice(0, 40));
      const st0 = lstatSync(g.lastGoodPath);
      ctx.check('last-good is a plain file of mode 600', st0.isFile() && (st0.mode & 0o777) === 0o600, (st0.mode & 0o777).toString(8));
      ctx.check('an existing state directory is brought to 700', (statSync(dir).mode & 0o777) === 0o700, (statSync(dir).mode & 0o777).toString(8));
      // A directory in its place, because the mode of the state directory is one tower repairs.
      rmSync(g.lastGoodPath);
      mkdirSync(join(g.lastGoodPath, 'in-the-way'), { recursive: true });
      g.writeConfig({ upstreams: { a: rawCfg(), b: rawCfg() } });
      const st = await waitFor(async () => { const s = await g.adminStatus(); return s?.upstreams?.b ? s : null; }, 3000, 50);
      ctx.check('a save that cannot reach the disk still applies', !!st);
      ctx.check('it is not reported as rejected', st?.config === 'ok' && !st?.configError && (await g.healthz()).json?.config === 'ok', `${st?.config} ${st?.configError ?? ''}`.slice(0, 80));
      ctx.check('warnings names the unwritten last-good', /last_good/.test(warningsText(st)), warningsText(st).slice(0, 120));
      rmSync(g.lastGoodPath, { recursive: true });
      g.writeConfig({ upstreams: { a: rawCfg(), b: rawCfg({}, { note: 'saved again' }) } });
      ctx.check('the next save clears the warning', await waitFor(async () => !/last_good/.test(warningsText(await g.adminStatus())), 3000, 50));
      ctx.check('and writes last-good', !!JSON.parse(readFileSync(g.lastGoodPath, 'utf8')).upstreams.b);
    },
  },
  {
    order: 46, row: 'x20', id: 'config-dir-replaced', timeoutMs: 20000,
    title: 'a config directory removed and made again is picked up without a restart',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { a: rawCfg() } });
      await g.start();
      await fullList(g, 4);
      const dir = dirname(g.cfgPath);
      const source = readFileSync(g.cfgPath, 'utf8');
      rmSync(dir, { recursive: true });
      ctx.check('gone: closed', await waitFor(async () => (await adminStatus(g)) === 503, 3000, 50));
      mkdirSync(dir);
      writeFileSync(join(dir, 'token'), g.token, { mode: 0o600 });
      writeFileSync(g.cfgPath, source);
      ctx.check('back: /admin answers again', await waitFor(async () => (await adminStatus(g)) === 200, 3000, 50));
      ctx.check('back: config ok', await waitFor(async () => (await g.healthz()).json?.config === 'ok', 3000, 50));
      ctx.check('the child stayed', isOk(await callTool(await g.open('modern'), 'a_echo')));
    },
  },
  {
    order: 47, row: 'x21', id: 'list-isolation', timeoutMs: 30000,
    title: 'a list that fails stays in lastError: no reconnect, no blocked calls, and the other lists still land',
    async run(ctx) {
      const up = await ctx.http('raw', P.alpha, { RAW_LIST_500_AFTER: '1' });
      const events = join(ctx.tmp, 'bad.jsonl');
      const g = ctx.gateway({ upstreams: {
        bad: rawCfg({ MALFORMED_AFTER: '1', EVENTS: events }, { refreshIntervalMs: 300 }),
        partial: rawCfg({ PROMPTS: 'fail' }, { refreshIntervalMs: 300 }),
        refused: { url: up.url, uriPrefixes: [], refreshIntervalMs: 300 },
      } });
      await g.start();
      await fullList(g, 9, 5000);
      await sleep(1500);
      const st = await g.adminStatus();
      const { bad, partial, refused } = st?.upstreams ?? {};
      ctx.check('malformed list: stays ready, no reconnect', bad?.state === 'ready' && bad?.restarts === 0, JSON.stringify(bad).slice(0, 120));
      ctx.check('malformed list: the one child was left alone', childLog(events).filter((e) => e.ev === 'spawn').length === 1);
      ctx.check('malformed list: the last good tools stay', bad?.tools === 4, `${bad?.tools}`);
      ctx.check('malformed list: lastError says why', /tools: /.test(bad?.lastError ?? ''), bad?.lastError?.slice(0, 80));
      const s = await g.open('modern');
      ctx.check('malformed list: calls still work', isOk(await callTool(s, 'bad_echo')));
      ctx.check('HTTP 500 on tools/list: stays ready, no reconnect', refused?.state === 'ready' && refused?.restarts === 0, JSON.stringify(refused).slice(0, 120));
      ctx.check('HTTP 500 on tools/list: lastError says why', /tools: /.test(refused?.lastError ?? ''), refused?.lastError?.slice(0, 80));
      ctx.check('HTTP 500 on tools/list: calls still work', isOk(await callTool(s, 'refused_whoami')));
      ctx.check('failing prompts/list: tools/list still lands', partial?.tools === 4, JSON.stringify(partial).slice(0, 120));
      ctx.check('failing prompts/list: lastError names that list', /^prompts: /.test(partial?.lastError ?? ''), partial?.lastError);
      ctx.check('failing prompts/list: it is ready, with a snapshot', partial?.state === 'ready' && partial?.snapshot === true);
    },
  },
  {
    order: 48, row: 'x22', id: 'templates-kept', timeoutMs: 20000,
    title: 'a template list that times out keeps its last good copy, shows in lastError and sends no list_changed',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { t: rawCfg({ RESOURCES: '1', TEMPLATES_HANG_FROM: '2', TEMPLATES_HANG_TO: '2' }, { uriPrefixes: ['fake://'], refreshIntervalMs: 500 }) } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      const L = listen(g.url, s, g.token);
      await waitFor(() => L.status === 200 || null, 3000, 20);
      const seen = new Set();
      let error;
      const end = now() + 5000;
      while (now() < end) {
        seen.add((await s.call('resources/templates/list')).json?.result?.resourceTemplates?.length);
        error ??= (await status(g, 't'))?.lastError;
        await sleep(100);
      }
      ctx.check('the merged list never loses the template', seen.size === 1 && seen.has(1), [...seen].join(','));
      ctx.check('lastError names the list', /resourceTemplates: /.test(error ?? ''), error ?? 'none');
      ctx.check('no list_changed for a list that did not change', !L.seen.some((e) => e.method === 'notifications/resources/list_changed'), L.seen.map((e) => e.method).join(','));
      ctx.check('lastError clears when the list answers', await waitFor(async () => !(await status(g, 't'))?.lastError, 3000, 50));
      L.close();
    },
  },
  {
    order: 49, row: 'x23', id: 'partial-first-list', timeoutMs: 40000,
    title: 'a first list still pending or timed out is recorded: list_partial, status, a retry whatever the refresh interval',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { slow: rawCfg({ INIT_DELAY_MS: '1500', FIRST_LIST_DELAY_MS: '2900' }) } });
      await g.start();
      const s = await g.open('modern', 15000);
      const L = listen(g.url, s, g.token);
      const first = toolNames(await s.call('tools/list', {}, 8000)) ?? [];
      ctx.check('connected, list pending: the answer is partial', first.length === 0, first.join(','));
      const partial = g.events().find((e) => e.event === 'list_partial');
      ctx.check('connected, list pending: list_partial names it', partial?.detail?.missing?.includes('slow'), JSON.stringify(partial));
      const during = await status(g, 'slow');
      ctx.check('connected, list pending: status marks it', during?.state === 'ready' && during?.snapshot === false, JSON.stringify(during).slice(0, 120));
      ctx.check('then the list arrives', (await fullList(g, 4, 5000)).length === 4);
      ctx.check('status shows the snapshot', (await status(g, 'slow'))?.snapshot === true);
      ctx.check('list_changed went out', await waitFor(() => L.seen.some((e) => e.method === 'notifications/tools/list_changed') || null, 2000, 20));
      L.close();
      await g.stop();
      const g2 = ctx.gateway({ upstreams: { lazy: rawCfg({ FIRST_LIST_DELAY_MS: '3300' }, { refreshIntervalMs: 0 }) } }, { name: 'gw2' });
      await g2.start();
      const empty = toolNames(await (await g2.open('modern', 8000)).call('tools/list', {}, 8000)) ?? [];
      ctx.check('first list timed out: the answer is partial and recorded', empty.length === 0 && g2.events().some((e) => e.event === 'list_partial'), empty.join(','));
      ctx.check('first list timed out: retried though refresh is off', (await fullList(g2, 4, 8000)).length === 4);
      ctx.check('first list timed out: lastError clears', !(await status(g2, 'lazy'))?.lastError);
    },
  },
  {
    order: 50, row: 'x24', id: 'retry-out-of-reach', timeoutMs: 40000,
    title: 'a call that cannot make the next retry fails at once instead of spending the wait first',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { a: rawCfg({ INIT_DELAY_MS: '300' }) } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      for (let i = 1; i <= 4; i += 1) {
        const u = await waitFor(async () => { const r = await status(g, 'a'); return r?.state === 'ready' && r.pid ? r : null; }, 8000, 20);
        process.kill(u.pid, 'SIGKILL');
        ctx.check(`kill ${i}: tower saw it`, !!(await stateIs(g, 'a', 'backoff')));
      }
      await sleep(150); // The retry is now 1.85 s off, and the child needs 0.3 s after that.
      const r = await callTool(s, 'a_echo', {}, 8000);
      ctx.metric('callMs', r.ms);
      ctx.check('it fails now', failed(r) && r.ms < 500, `${r.ms} ms ${textOf(r).slice(0, 60)}`);
      ctx.check('the next attempt still comes', !!(await stateIs(g, 'a', 'ready')));
    },
  },
  {
    order: 51, row: 'x25', id: 'sse-death', timeoutMs: 40000,
    title: 'an HTTP upstream that dies with a call on an SSE response ends that call now, as upstream_closed',
    async run(ctx) {
      const alpha = await ctx.http('alpha', P.alpha, { ALPHA_EXTRA: '1' });
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(P.alpha, { refreshIntervalMs: 0, callTimeoutMs: 30000 }) } });
      await g.start();
      await fullList(g, 3);
      const s = await g.open('modern', 40000);
      const call = s.call('tools/call', { name: 'alpha_slow', arguments: { ms: 60000 }, _meta: { progressToken: 7 } }, 40000);
      await sleep(1300);
      const t0 = now();
      alpha.kill('SIGKILL');
      const r = await call;
      ctx.metric('endedAfterMs', ms(t0));
      ctx.check('the call ends at once, as an isError', r.json?.result?.isError === true && ms(t0) < 2000, `${ms(t0)} ms ${textOf(r).slice(0, 80)}`);
      ctx.check('the log says upstream_closed', g.events('call').at(-1)?.status === 'upstream_closed', g.events('call').at(-1)?.status);
      ctx.check('the upstream left ready', (await status(g, 'alpha'))?.state !== 'ready');
      await ctx.http('alpha', P.alpha, { ALPHA_EXTRA: '1' }, 'alpha2');
      ctx.check('it reconnects by itself with refresh off', !!(await stateIs(g, 'alpha', 'ready')));
      ctx.check('and calls work again', isOk(await callTool(s, 'alpha_status')));
    },
  },
  {
    order: 52, row: 'x26', id: 'call-max', timeoutMs: 30000,
    title: 'callMaxMs is a total limit: a silent call and a call with progress both end there',
    async run(ctx) {
      const server = patchedServer('call-max', [['AbortSignal.timeout(CALL_MAX_MS)', 'AbortSignal.timeout(1500)']]);
      const g = ctx.gateway({ upstreams: { a: rawCfg({}, { callTimeoutMs: 20000 }) } }, { server });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern', 10000);
      const silent = await callTool(s, 'a_slow', { ms: 5000 }, 10000);
      ctx.check('a silent call ends at the limit', failed(silent) && silent.ms >= 1200 && silent.ms <= 3000, `${silent.ms} ms ${textOf(silent).slice(0, 60)}`);
      ctx.check('it is logged as a timeout', g.events('call').at(-1)?.status === 'timeout', g.events('call').at(-1)?.status);
      const steady = await s.call('tools/call', { name: 'a_slow', arguments: { ms: 4500, steps: 9 }, _meta: { progressToken: 3 } }, 10000);
      ctx.check('progress does not extend it', failed(steady) && steady.ms >= 1200 && steady.ms <= 3000, `${steady.ms} ms`);
    },
  },
  {
    order: 53, row: 'x27', id: 'progress-all-relays', timeoutMs: 20000,
    title: 'prompts/get relays progress under the caller\'s token and cannot reach another call',
    async run(ctx) {
      const events = join(ctx.tmp, 'a.jsonl');
      const g = ctx.gateway({ upstreams: { a: rawCfg({ EVENTS: events, PROMPTS: '1' }) } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      const progress = (r) => r.frames.filter((f) => f.method === 'notifications/progress');
      const p = await s.call('prompts/get', { name: 'a_p', _meta: { progressToken: 999999 } });
      ctx.check('prompts/get relays progress', progress(p).length === 1 && progress(p)[0].params.progressToken === 999999, JSON.stringify(p.frames).slice(0, 120));
      const seen = childLog(events).find((e) => e.method === 'prompts/get')?.meta?.progressToken;
      ctx.check('the upstream gets tower\'s token, not the caller\'s', seen !== undefined && seen !== 999999, String(seen));
      const a = s.call('tools/call', { name: 'a_slow', arguments: { ms: 1200, steps: 1 }, _meta: { progressToken: 'token-of-a' } });
      await sleep(300);
      const id = childLog(events).filter((e) => e.method === 'tools/call').at(-1).id;
      const b = await s.call('prompts/get', { name: 'a_p', _meta: { progressToken: id } });
      const ra = await a;
      ctx.check('a caller\'s token equal to another call\'s id reaches that caller only', progress(b).length === 1 && !progress(ra).some((f) => /prompts\/get/.test(f.params.message ?? '')), `a: ${JSON.stringify(progress(ra)).slice(0, 100)}`);
    },
  },
  {
    order: 54, row: 'x28', id: 'start-bound', timeoutMs: 40000,
    title: 'startTimeoutMs bounds the whole connect, the notification that ends the handshake included',
    async run(ctx) {
      const up = await ctx.http('raw', P.alpha, { RAW_HANG_INITIALIZED: '1' });
      const g = ctx.gateway({ upstreams: { r: { url: up.url, uriPrefixes: [] } } });
      const t0 = now();
      await g.start();
      const failedOnce = await waitFor(async () => { const u = await status(g, 'r'); return u?.lastError ? u : null; }, 18000, 100);
      ctx.metric('failedAfterMs', ms(t0));
      ctx.check('the attempt fails', /start timed out/.test(failedOnce?.lastError ?? ''), JSON.stringify(failedOnce).slice(0, 120));
      ctx.check('at the limit', ms(t0) >= 14000 && ms(t0) <= 17000, `${ms(t0)} ms`);
      ctx.check('and is retried', await waitFor(async () => (await status(g, 'r'))?.restarts >= 1, 3000, 50));
    },
  },
  {
    order: 55, row: 'x29', id: 'input-required', timeoutMs: 20000,
    title: 'input_required relays with an output schema, and an upstream sees the caller\'s capabilities, not tower\'s',
    async run(ctx) {
      const up = await ctx.http('modern', P.alpha);
      const g = ctx.gateway({ upstreams: { m: { url: up.url, autoApprove: ['*'], uriPrefixes: [] } } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      const call = (name, caps, extra = {}) => s.call('tools/call', { name, arguments: {}, _meta: { 'io.modelcontextprotocol/clientCapabilities': caps }, ...extra });
      const asked = (r) => Object.keys(r.json?.result?.inputRequests ?? {}).join(',');
      const elicit = { elicitation: { form: {} } };
      for (const name of ['m_plain', 'm_typed']) {
        const r = await call(name, elicit);
        ctx.check(`${name}: relayed`, r.status === 200 && r.json?.result?.resultType === 'input_required' && asked(r) === 'confirm', JSON.stringify(r.json).slice(0, 120));
      }
      const done = await call('m_typed', elicit, { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
      ctx.check('m_typed: the second leg returns the result', done.json?.result?.structuredContent?.ok === true, JSON.stringify(done.json).slice(0, 120));
      const none = await call('m_caps', {});
      ctx.check('a caller with no capabilities gets the tool\'s normal result', none.status === 200 && /no input needed, declared nothing/.test(textOf(none)), JSON.stringify(none.json).slice(0, 120));
      const sampling = await call('m_caps', { sampling: {} });
      ctx.check('a sampling caller is asked for sampling only', sampling.status === 200 && asked(sampling) === 'greeting', JSON.stringify(sampling.json).slice(0, 120));
      const form = await call('m_caps', elicit);
      ctx.check('an elicitation caller is asked for elicitation only', form.status === 200 && asked(form) === 'name', JSON.stringify(form.json).slice(0, 120));
      const legacy = await callTool(await g.open('legacy'), 'm_caps');
      ctx.check('a legacy caller declares nothing, so the tool answers normally', /declared nothing/.test(textOf(legacy)), JSON.stringify(legacy.json).slice(0, 120));
    },
  },
  {
    order: 56, row: 'x30', id: 'dead-child-held-stdout', timeoutMs: 30000,
    title: 'a child that dies while a helper of its holds stdout is noticed at the next failed refresh',
    async run(ctx) {
      const script = join(ctx.tmp, 'wrapper.sh');
      writeFileSync(script, `#!/bin/sh\nsleep 40 &\nexec ${NODE} ${join(UPSTREAMS, 'raw-stdio.mjs')} wrapped\n`, { mode: 0o755 });
      const g = ctx.gateway({ upstreams: { w: { command: script, uriPrefixes: [], callTimeoutMs: 1500, refreshIntervalMs: 500 } } });
      await g.start();
      await fullList(g, 4);
      const before = await status(g, 'w');
      process.kill(before.pid, 'SIGKILL');
      const t0 = now();
      const back = await waitFor(async () => { const u = await status(g, 'w'); return u?.state === 'ready' && u.pid !== before.pid ? u : null; }, 10000, 50);
      ctx.metric('backAfterMs', ms(t0));
      ctx.check('a new child takes over', !!back, JSON.stringify(await status(g, 'w')).slice(0, 120));
      ctx.check('and answers', isOk(await callTool(await g.open('modern'), 'w_echo', {}, 5000)));
    },
  },
  {
    order: 57, row: 'x31', id: 'oversize-message', timeoutMs: 40000,
    title: 'a stdio message up to the limit passes, and one over it fails naming the cause',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { a: rawCfg() } });
      await g.start();
      await fullList(g, 4);
      const big = await callTool(await g.open('modern', 20000), 'a_big', { bytes: 11_000_000 }, 20000);
      ctx.check('11 MB passes the SDK default of 10 MiB', isOk(big) && textOf(big).length === 11_000_000, `${textOf(big).length} ${textOf(big).slice(0, 60)}`);
      await g.stop();
      const server = patchedServer('oversize', [['maxBytes: 2 ** 26', 'maxBytes: 2 ** 20']]);
      const small = ctx.gateway({ upstreams: { a: rawCfg() } }, { server, name: 'gw2' });
      await small.start();
      await fullList(small, 4);
      const s = await small.open('modern', 20000);
      const over = await callTool(s, 'a_big', { bytes: 2_000_000 }, 20000);
      ctx.check('over the limit the model is told why', over.json?.result?.isError === true && /ReadBuffer exceeded/.test(textOf(over)), textOf(over).slice(0, 100));
      ctx.check('the log says upstream_closed', small.events('call').at(-1)?.status === 'upstream_closed', small.events('call').at(-1)?.status);
      ctx.check('lastError has the cause', /ReadBuffer exceeded/.test((await status(small, 'a'))?.lastError ?? ''));
      ctx.check('and the child comes back', !!(await stateIs(small, 'a', 'ready')));
    },
  },
  {
    order: 58, row: 'x32', id: 'instructions-well-formed', timeoutMs: 30000,
    title: 'cut instructions stay well-formed when the cut lands inside an astral character',
    async run(ctx) {
      for (const n of [1, 3]) {
        const upstreams = Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, rawCfg({ INSTRUCTIONS: '😀', INSTR_REPEAT: '3000' })]));
        const g = ctx.gateway({ upstreams }, { name: `gw${n}` });
        await g.start();
        await fullList(g, 4 * n);
        const text = (await g.open('modern')).instructions ?? '';
        ctx.check(`${n} upstream(s): well-formed`, text.length > 1000 && text.isWellFormed(), `${text.length}`);
        ctx.check(`${n} upstream(s): within 4,096`, text.length <= 4096, `${text.length}`);
        await g.stop();
      }
    },
  },
  {
    order: 59, row: 'x33', id: 'failures-clear', timeoutMs: 30000,
    title: 'the failure count in status clears after the time in ready that clears the backoff',
    async run(ctx) {
      const server = patchedServer('failures-clear', [['>= 60_000', '>= 1_500']]);
      const g = ctx.gateway({ upstreams: { a: rawCfg({ FLAP_FILE: join(ctx.tmp, 'flap'), FLAP_COUNT: '2' }) } }, { server });
      await g.start();
      const settled = await waitFor(async () => { const u = await status(g, 'a'); return u?.state === 'ready' && u.restarts === 2 ? u : null; }, 8000, 20);
      ctx.check('two flaps show as two failures', settled?.failures === 2, JSON.stringify(settled).slice(0, 100));
      ctx.check('status clears it by itself', await waitFor(async () => (await status(g, 'a'))?.failures === 0, 3000, 50));
      process.kill((await status(g, 'a')).pid, 'SIGKILL');
      await stateIs(g, 'a', 'backoff');
      const delay = g.events().filter((e) => e.event === 'upstream_state').at(-1)?.detail?.delay;
      ctx.check('the next delay starts over', delay === 250, String(delay));
    },
  },
  {
    order: 60, row: 'x34', id: 'wait-logged', timeoutMs: 20000,
    title: 'a call that waited and then failed logs that wait',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { h: rawCfg({ INIT_HANG: '1' }) } });
      await g.start();
      await callTool(await g.open('modern', 8000), 'h_echo', {}, 8000);
      const line = g.events('call').at(-1);
      ctx.check('waitMs holds the wait', line?.status === 'upstream_down' && line?.waitMs >= 3000, JSON.stringify(line).slice(0, 140));
    },
  },
  {
    order: 61, row: 'x35', id: 'audit-trail', timeoutMs: 20000,
    title: 'tools_changed from an empty first list, its time in status, and no raw URI in the log',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { a: rawCfg({ NO_TOOLS_FIRST: '1', READ_OK: '1' }, { refreshIntervalMs: 200, uriPrefixes: ['private/', 'fake://'] }) } });
      await g.start();
      const ev = await waitFor(() => g.events().find((e) => e.event === 'tools_changed') ?? null, 3000, 20);
      ctx.check('the first tools after an empty first list are recorded', ['echo', 'slow', 'die', 'big'].every((n) => ev?.detail?.names?.includes(n)), JSON.stringify(ev?.detail));
      const at = (await status(g, 'a'))?.toolsChangedAt;
      ctx.check('status has the time of the last change', Number.isFinite(Date.parse(at)), String(at));
      const s = await g.open('modern');
      await s.call('resources/read', { uri: 'private/patient-records/kim-minsu.pdf' });
      const plain = g.events('call').at(-1);
      ctx.check('a URI with no scheme logs no scheme', plain?.method === 'resources/read' && plain?.uriScheme === undefined && !!plain?.uriHash, JSON.stringify(plain).slice(0, 140));
      ctx.check('and the raw URI is nowhere in the log', !g.logLines().some((l) => l.includes('kim-minsu')));
      await s.call('resources/read', { uri: 'fake://x' });
      ctx.check('a URI with a scheme logs it', g.events('call').at(-1)?.uriScheme === 'fake', g.events('call').at(-1)?.uriScheme);
    },
  },
  {
    order: 62, row: 'x36', id: 'redaction', timeoutMs: 40000,
    title: 'substituted values stay out of every error the model sees, in every form an upstream echoes them',
    async run(ctx) {
      const S = { PLAIN: 'CANARY-SECRET-value-1234', PFX: 'CANARY-PFX', LONG: 'CANARY-PFX-LONGER-SECRET-tail', QUOTED: 'CANARY"QUOTE\\7e' };
      const headers = { Authorization: 'Bearer ${PLAIN}', 'X-Pfx': '${PFX}', 'X-Long': '${LONG}', 'X-Quoted': '${QUOTED}', 'X-Debug': '${DEBUG}' };
      const env = `PLAIN=${S.PLAIN}\nPFX=${S.PFX}\nLONG=${S.LONG}\nQUOTED='${S.QUOTED}'\nDEBUG=1\n`;
      // Parts, not whole values: a tail left behind counts, and QUOTE stays findable however many times the value was escaped on the way.
      const leaks = (text) => ['value-1234', 'CANARY-PFX', 'LONGER-SECRET-tail', 'QUOTE'].filter((part) => text.includes(part));
      for (const mode of ['http', 'rpc']) {
        const up = await ctx.http('raw', P.alpha, { RAW_ECHO: mode }, `raw-${mode}`);
        const g = ctx.gateway({ upstreams: { notes: { url: up.url, headers, uriPrefixes: ['raw://'], refreshIntervalMs: 0 } } }, { name: `gw-${mode}` });
        envFile(g, env);
        await g.start();
        await fullList(g, 1);
        const s = await g.open('modern');
        const answers = { 'tools/call': await callTool(s, 'notes_whoami'), 'prompts/get': await s.call('prompts/get', { name: 'notes_hello' }), 'resources/read': await s.call('resources/read', { uri: 'raw://one' }) };
        for (const [method, r] of Object.entries(answers)) {
          const text = JSON.stringify(r.json);
          ctx.check(`${mode} ${method}: the upstream's error arrives`, /rejected/.test(text), text.slice(0, 120));
          ctx.check(`${mode} ${method}: no value in it, whole or in part`, leaks(text).length === 0, `${leaks(text).join(',')} ${text.slice(0, 80)}`);
        }
        ctx.check(`${mode}: nor in the journal`, leaks(g.logLines().join('\n')).length === 0);
        ctx.check(`${mode}: a short value leaves the journal alone`, g.events().every((e) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.ts)), g.events().at(0)?.ts);
        await g.stop();
        await up.stop();
      }
      const secret = 'CANARY-RING-6af2c1d9';
      const g = ctx.gateway({ upstreams: {} }, { name: 'gw-ring' });
      envFile(g, `RING=${secret}\n`);
      g.writeConfig({ upstreams: { a: rawCfg({ STDERR_TEXT: '${RING}', STDERR_PAD: '65530' }) } });
      await g.start();
      await fullList(g, 4);
      const named = await rawRequest({ port: g.port, path: '/admin/upstreams/a', headers: { Authorization: `Bearer ${g.token}` }, readMs: 300 });
      const ring = jsonBody(named)?.stderr ?? '';
      ctx.check('a value cut by the stderr ring leaves no tail', ring.length > 60000 && !ring.includes(secret.slice(-5)), JSON.stringify(ring.slice(0, 40)));
    },
  },
  {
    order: 63, row: 'x37', id: 'bad-headers', timeoutMs: 20000,
    title: 'a value that cannot be a header is refused by validation, unquoted, and no route can throw one at stderr',
    async run(ctx) {
      const canary = 'CANARY-BADHDR-11aa22bb';
      const origin = await startOrigin(P.origin);
      ctx.onCleanup(() => origin.close());
      const proxy = `http://127.0.0.1:${P.origin}`;
      const g = ctx.gateway({ upstreams: {}, routes: { odd: { path: '/odd', proxy, requestHeaders: { 'X Not A Name': 'value' } } } });
      envFile(g, `BADHDR="${canary}\\nsecond-line"\n`);
      const write = (name, spec) => { const file = join(ctx.tmp, `${name}.json`); writeFileSync(file, JSON.stringify(spec)); return file; };
      const route = await cli(g, ['validate', write('route', { routes: { r: { path: '/r', proxy, requestHeaders: { 'X-Bad': '${BADHDR}' } } } })]);
      ctx.check('in a route: refused, without the value', route.code === 1 && /cannot be a header value/.test(route.err) && !route.err.includes(canary), route.err.slice(0, 120));
      const upstream = await cli(g, ['validate', write('up', { upstreams: { u: { url: `${proxy}/mcp`, headers: { 'X-Bad': '${BADHDR}' } } } })]);
      ctx.check('in an upstream: refused, without the value', upstream.code === 1 && !upstream.err.includes(canary), upstream.err.slice(0, 120));
      const env = await cli(g, ['validate', write('env', { upstreams: { u: { command: NODE, env: { MULTILINE: '${BADHDR}' } } } })]);
      ctx.check('in env the same value is fine', env.code === 0, env.err.slice(0, 120));
      await g.start();
      const r = await rawRequest({ port: g.port, path: '/odd/x' });
      ctx.check('a header name the platform refuses is a 502', r.status === 502 && origin.state.hits.length === 0, `${r.status}`);
      ctx.check('with nothing printed past the log', !g.logLines().some((l) => /TypeError|at webidl/.test(l)), g.logTail(120));
      ctx.check('a good bearer still gets through the error handler', (await adminStatus(g)) === 200);
      ctx.check('a wrong one is still 401, not 500', (await adminStatus(g, 'f'.repeat(64))) === 401);
    },
  },
  {
    order: 64, row: 'x38', id: 'meta-scrub', timeoutMs: 20000,
    title: 'no anthropic/* or claude/* key from an upstream survives on a prompt, resource, template or result',
    async run(ctx) {
      const up = await ctx.http('modern', P.alpha);
      const g = ctx.gateway({ upstreams: { m: { url: up.url, autoApprove: ['meta'], uriPrefixes: ['modern://'] } } });
      await g.start();
      await fullList(g, 4);
      const reserved = (item) => Object.keys(item?._meta ?? {}).filter((k) => /^(anthropic|claude)\//.test(k));
      for (const era of ['modern', 'legacy']) {
        const s = await g.open(era);
        const result = (await callTool(s, 'm_meta')).json?.result;
        const prompt = (await s.call('prompts/list')).json?.result?.prompts?.[0];
        const got = (await s.call('prompts/get', { name: 'm_pr' })).json?.result;
        const resource = (await s.call('resources/list')).json?.result?.resources?.[0];
        const template = (await s.call('resources/templates/list')).json?.result?.resourceTemplates?.[0];
        const read = (await s.call('resources/read', { uri: 'modern://one' })).json?.result;
        const items = { result, prompt, got, resource, template, read, contents: read?.contents?.[0] };
        for (const [name, item] of Object.entries(items)) {
          ctx.check(`${era} ${name}: present, nothing reserved left`, !!item && reserved(item).length === 0, JSON.stringify(item?._meta));
          if (name !== 'got' && name !== 'read') ctx.check(`${era} ${name}: other _meta stays`, item?._meta?.['x.keep/marker'] === 'kept', JSON.stringify(item?._meta));
        }
      }
    },
  },
  {
    order: 65, row: 'x39', id: 'unit-stop', timeoutMs: 40000,
    title: 'ops/systemd stops the way section 7 says: the call finishes, then stdin EOF, and no signal reaches the child first',
    async run(ctx) {
      if (!(await systemdAvailable())) { ctx.check('systemd --user is available (transient units)', false); return; }
      const dir = join(REPO, 'ops/systemd');
      const parse = (file, section) => readFileSync(join(dir, file), 'utf8').split(/^\[/m).find((s) => s.startsWith(`${section}]`)).split('\n').filter((l) => /^\w+=/.test(l));
      const service = [...parse('tower.service', 'Unit'), ...parse('tower.service', 'Service')];
      ctx.check('the unit keeps SIGTERM for tower alone', service.includes('KillMode=mixed'), service.join(' ').slice(0, 120));
      const events = join(ctx.tmp, 'child.jsonl');
      const g = ctx.gateway({ upstreams: { a: rawCfg({ EVENTS: events }) } });
      const exec = service.find((l) => l.startsWith('ExecStart=')).slice('ExecStart='.length).split(' ');
      const props = service.filter((l) => !/^(ExecStart|Description|Requires|After)=/.test(l)).map((l) => l.replace('%C', ctx.tmp));
      const unit = `tower-regtest-stop-${process.pid}-${Date.now() % 100000}`;
      const socket = parse('tower.socket', 'Socket').map((l) => l.replace(':4800', `:${g.port}`));
      const u = await startTransient({ unit, socket, service: props, cmd: exec[0], args: exec.slice(1), env: g.envFor(), logFile: join(ctx.tmp, 'unit.log') });
      ctx.onCleanup(() => u.stop());
      await g.healthz();
      await fullList(g, 4);
      const s = await g.open('modern', 15000);
      const call = callTool(s, 'a_slow', { ms: 1000 }, 10000);
      await sleep(200);
      const t0 = now();
      await u.stopService();
      ctx.metric('stopMs', ms(t0));
      const r = await call;
      ctx.check('the call in flight gets its result', isOk(r) && /slept 1000/.test(textOf(r)), textOf(r).slice(0, 80) || String(r.raw));
      const seen = childLog(events).filter((e) => ['done', 'stdin_eof', 'sigterm'].includes(e.ev)).map((e) => e.ev);
      ctx.check('the child finished the call, then saw stdin close, and no SIGTERM', seen.join(',') === 'done,stdin_eof', seen.join(','));
    },
  },
  {
    order: 66, row: 'x40', id: 'cancel-by-close', timeoutMs: 20000,
    title: 'a caller that goes away cancels its call in both eras (the legacy cancel notification has no way to the call)',
    async run(ctx) {
      const events = join(ctx.tmp, 'a.jsonl');
      const g = ctx.gateway({ upstreams: { a: rawCfg({ EVENTS: events }) } });
      await g.start();
      await fullList(g, 4);
      for (const era of ['modern', 'legacy']) {
        const before = childLog(events).filter((e) => e.ev === 'cancelled').length;
        const s = await g.open(era);
        await callTool(s, 'a_slow', { ms: 3000, steps: 6 }, 500);
        ctx.check(`${era}: the upstream is told`, await waitFor(() => childLog(events).filter((e) => e.ev === 'cancelled').length > before || null, 2000, 20));
      }
    },
  },
];

const exported = scenarios.map(towerOnly);
export { exported as scenarios };
