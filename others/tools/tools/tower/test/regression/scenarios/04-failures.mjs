// Section 10 rows 10-15: hung, dead and restarted pieces.
import { join } from 'node:path';
import { P } from '../harness/env.mjs';
import { alphaCfg, betaCfg, pidOf, PY1, realPyCfg } from '../lib/fixtures.mjs';
import { fullList, jsonText, textOf, toolNames } from '../lib/helpers.mjs';
import { failKind, failed, isOk, listen } from '../lib/mcp.mjs';
import { callTool } from '../lib/mcp.mjs';
import { waitPort } from '../lib/http.mjs';
import { spikeSocketCopy, TARGET, upstreamStatus } from '../lib/target.mjs';
import { startSocketUnit, systemdAvailable } from '../lib/systemd.mjs';
import { median, ms, now, sleep, waitFor } from '../lib/util.mjs';

const echo = (s, t = 15000) => callTool(s, 'beta_beta_echo', { text: 'x' }, t);

export const scenarios = [
  {
    order: 10, row: 10, id: 'closed-port', timeoutMs: 170000,
    title: 'upstream down +75 s, and a never-bound port: list < 50 ms, call <= 2 s',
    async run(ctx) {
      const alpha = await ctx.http('alpha', P.alpha);
      const spec = { upstreams: { alpha: alphaCfg(), dead: { url: `http://127.0.0.1:${P.never}/mcp`, uriPrefixes: [] }, beta: betaCfg(join(ctx.tmp, 'beta.log')) } };
      const g = ctx.gateway(spec);
      await g.start();
      const names = await fullList(g, 4, 12000);
      ctx.check('baseline: alpha and beta tools listed', names.includes('alpha_status') && names.includes('beta_status'), names.join(','));
      const s0 = await g.open('modern');
      ctx.check('baseline: alpha call works', isOk(await callTool(s0, 'alpha_status')));
      await alpha.stop();
      const tDown = now();
      await sleep(Math.max(0, 75000 - (now() - tDown)));
      const s = await g.open('modern', 30000);
      const l1 = await s.call('tools/list', {}, 30000);
      const l2 = await s.call('tools/list', {}, 30000);
      const ca = await callTool(s, 'alpha_status', {}, 30000);
      const cd = await callTool(s, 'dead_status', {}, 30000);
      const m = { listMs: [l1.ms, l2.ms], callDownMs: ca.ms, callDownKind: failKind(ca), callNeverBoundMs: cd.ms, callNeverBoundKind: failKind(cd), listedAlpha: (toolNames(l2) ?? []).filter((n) => n.startsWith('alpha_')).length };
      for (const [k, v] of Object.entries(m)) ctx.metric(k, v);
      ctx.check('tools/list < 50 ms with the upstream down 75 s', Math.max(...m.listMs) < 50, `list ${m.listMs.join(', ')} ms`);
      ctx.check('call to the down upstream returns within 2 s', ca.ms <= 2000, `${ca.ms} ms ${failKind(ca)}`);
      ctx.check('call to the down upstream is a failure, not a result', failed(ca), failKind(ca));
      ctx.check('call to a never-bound port returns within 2 s', cd.ms <= 2000, `${cd.ms} ms ${failKind(cd)}`);
      ctx.docResult('list 3,004 ms, call 10,427 ms', m.listMs.every((x) => x >= 2500 && x <= 3800) && ca.ms >= 8000, `list ${m.listMs.join('/')} ms, call down ${ca.ms} ms (${failKind(ca)}), call never-bound ${cd.ms} ms`);
    },
  },
  {
    order: 11, row: 11, id: 'sigstop-child', timeoutMs: 120000,
    title: 'SIGSTOP on a stdio child: list < 50 ms, call fails at callTimeoutMs, lastError visible',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const CAP = 30000;
      const spec = { upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log'), { callTimeoutMs: 5000, refreshIntervalMs: 2000 }) } };
      const g = ctx.gateway(spec);
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern', CAP + 5000);
      const pid = pidOf(textOf(await echo(s)));
      ctx.check('child pid known', pid > 0);
      process.kill(pid, 'SIGSTOP');
      ctx.onCleanup(() => { try { process.kill(pid, 'SIGCONT'); } catch {} });
      const t0 = now();
      const [l, ca, cb] = await Promise.all([s.call('tools/list', {}, CAP), callTool(s, 'alpha_status', {}, CAP), echo(s, CAP)]);
      ctx.metric('listMs', l.ms); ctx.metric('callAlphaMs', ca.ms); ctx.metric('callBetaMs', cb.ms); ctx.metric('callBetaKind', failKind(cb));
      ctx.check('tools/list < 50 ms', l.ms < 50, `${l.ms} ms, ${toolNames(l)?.length ?? 'no'} tools`);
      ctx.check('call to the healthy upstream is unaffected', isOk(ca) && ca.ms < 500, `${ca.ms} ms`);
      ctx.check('call to the stopped child fails at callTimeoutMs (5 s configured)', failed(cb) && cb.ms >= 4000 && cb.ms <= 8000, `${failKind(cb)} after ${cb.ms} ms (cap ${CAP} ms)`);
      const seen = await waitFor(async () => { const st = await g.adminStatus(); const u = upstreamStatus(st, 'beta'); return u?.lastError ? u.lastError : null; }, 12000, 500);
      ctx.check('refresh failure is visible as lastError in /admin/status', !!seen, seen ? String(seen).slice(0, 80) : 'no lastError');
      ctx.docResult('list 3,005 ms, call over 85 s', l.ms >= 2500 && l.ms <= 3800 && cb.timedOut === true, `list ${l.ms} ms, beta call ${cb.timedOut ? `still hung at the ${CAP / 1000} s cap (documented >85 s, not run that long)` : `${failKind(cb)} after ${cb.ms} ms`}`);
      void t0;
    },
  },
  {
    order: 12, row: 12, id: 'stateful-http', timeoutMs: 60000,
    title: 'session-based HTTP upstream restarts: recovered on the first retry',
    async run(ctx) {
      let alpha = await ctx.http('alpha', P.alpha, { ALPHA_STATEFUL: '1' });
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg() } }, { env: TARGET === 'spike' ? { GW_RETRY_MS: '200' } : {} });
      await g.start();
      await fullList(g, 2);
      const s = await g.open('modern');
      ctx.check('call works before the restart', isOk(await callTool(s, 'alpha_status')));
      await alpha.stop();
      alpha = await ctx.http('alpha', P.alpha, { ALPHA_STATEFUL: '1' }, 'alpha-restarted');
      await sleep(200);
      const first = await callTool(s, 'alpha_status', {}, 15000);
      let attempt = isOk(first) ? 1 : 0;
      let second = null;
      if (!attempt) { await sleep(2000); second = await callTool(s, 'alpha_status', {}, 15000); attempt = isOk(second) ? 2 : 0; }
      ctx.metric('recoveredOnAttempt', attempt);
      ctx.check('recovered by the first retry (call 1 or 2 after the restart)', attempt > 0, `call1=${failKind(first)}${second ? ` call2=${failKind(second)}` : ''}`);
      const fresh = await callTool(await g.open('modern'), 'alpha_status');
      ctx.check('a new session works too', isOk(fresh), failKind(fresh));
      ctx.docResult('first retry recovers', attempt > 0, `recovered on attempt ${attempt}`);
    },
  },
  {
    order: 13, row: 13, id: 'respawn-backoff', timeoutMs: 120000,
    title: 'child SIGKILL x5: exponential backoff, a waiting call succeeds',
    async run(ctx) {
      const g = ctx.gateway({ upstreams: { beta: betaCfg(join(ctx.tmp, 'beta.log')) } }, { env: TARGET === 'spike' ? { GW_RETRY_MS: '1000' } : {} });
      await g.start();
      await fullList(g, 2);
      const s = await g.open('modern', 30000);
      const times = [];
      const immediate = [];
      for (let i = 0; i < 5; i++) {
        let pid = 0;
        const ready = await waitFor(async () => { const r = await echo(s, 8000); pid = pidOf(textOf(r)); return isOk(r) && pid ? pid : null; }, 15000, 100);
        if (!ready) { ctx.check(`kill ${i + 1}: child reachable before the kill`, false); break; }
        process.kill(pid, 'SIGKILL');
        const t0 = now();
        // Sent before tower sees the child close, a call is in flight, and section 4 ends those as isError and never resends them.
        if (TARGET === 'tower') await waitFor(async () => upstreamStatus(await g.adminStatus(), 'beta')?.state === 'backoff', 3000, 5);
        const r1 = await echo(s, 12000);
        const ok1 = isOk(r1) && pidOf(textOf(r1)) && pidOf(textOf(r1)) !== pid;
        immediate.push(ok1 ? 'ok' : failKind(r1));
        let t = ok1 ? ms(t0) : null;
        while (t === null && ms(t0) < 20000) {
          const r = await echo(s, 8000);
          const p2 = pidOf(textOf(r));
          if (isOk(r) && p2 && p2 !== pid) t = ms(t0); else await sleep(20);
        }
        times.push(t);
        await sleep(600);
      }
      ctx.metric('recoverMs', times); ctx.metric('immediateCall', immediate);
      ctx.check('all 5 kills recovered', times.length === 5 && times.every((t) => t !== null), `times ${times.join(', ')}`);
      if (times.length === 5 && times.every((t) => t !== null)) {
        ctx.check('backoff grows exponentially (t3 > 1.5 t1, t5 > 1.5 t3)', times[2] > times[0] * 1.5 && times[4] > times[2] * 1.5, `recover ms ${times.join(', ')}`);
      }
      ctx.check('a call issued once tower saw kills 1-3 waits and succeeds', immediate.slice(0, 3).length === 3 && immediate.slice(0, 3).every((x) => x === 'ok'), `immediate calls: ${immediate.join(', ')}`);
      ctx.docResult('fixed 1.13 s', times.length === 5 && times.every((t) => t !== null && t >= 1000 && t <= 1300), `recover ms ${times.join(', ')}`);
    },
  },
  {
    order: 14, row: 14, id: 'kill-tower', timeoutMs: 90000,
    title: 'gateway SIGKILL under socket activation with a Python child: only the in-flight call fails',
    async run(ctx) {
      if (!(await systemdAvailable())) { ctx.check('systemd --user is available (transient units)', false, 'systemctl --user is-system-running failed'); return; }
      const spec = { upstreams: { alpha: alphaCfg(), real: realPyCfg(PY1, join(ctx.tmp, 'py.log')) } };
      await ctx.http('alpha', P.alpha);
      const g = ctx.gateway(spec);
      const c = g.commandFor();
      const script = TARGET === 'spike' ? spikeSocketCopy() : c.args[0];
      const unit = `tower-regtest-${process.pid}-${Date.now() % 100000}`;
      const u = await startSocketUnit({ unit, port: g.port, cmd: c.cmd, args: [script], env: c.env, cwd: ctx.tmp, logFile: join(ctx.tmp, 'unit.log') });
      ctx.onCleanup(() => u.stop());
      const s = await g.open('modern', 15000);
      const okFirst = await waitFor(async () => { const r = await callTool(s, 'real_echo', { text: 'x' }, 10000); return isOk(r) ? r : null; }, 20000, 200);
      ctx.check('socket-activated gateway serves the Python tool', !!okFirst);
      for (let i = 0; i < 5; i++) { await callTool(s, 'real_echo', { text: 'x' }, 5000); await sleep(40); }
      const mainPid = await u.mainPid();
      ctx.check('main pid found', mainPid > 0, String(mainPid));
      process.kill(mainPid, 'SIGKILL');
      const t0 = now();
      const seq = [];
      let last = '';
      while (ms(t0) < 6000) {
        const r = await callTool(s, 'real_echo', { text: 'x' }, 8000);
        const k = isOk(r) ? 'ok' : failKind(r);
        if (k !== last) { seq.push({ at: ms(t0), kind: k, lat: Math.round(r.ms) }); last = k; }
        await sleep(40);
      }
      ctx.metric('sequence', seq);
      const bad = seq.filter((x) => x.kind !== 'ok');
      const lastOk = seq.at(-1)?.kind === 'ok';
      const recoveredAt = seq.find((x, i) => x.kind === 'ok' && i > 0)?.at ?? null;
      ctx.check('the call after the kill ends in success (waits for the restart)', lastOk && recoveredAt !== null, JSON.stringify(seq).slice(0, 150));
      ctx.check('only the in-flight call fails: no isError or JSON-RPC error afterwards', bad.every((x) => x.kind === 'transport' || x.kind === 'timeout') && bad.length <= 1, `failures: ${bad.map((x) => `${x.kind}@${x.at}`).join(', ') || 'none'}`);
      ctx.docResult('next call isError', seq.some((x) => x.kind === 'isError'), `sequence ${seq.map((x) => `${x.kind}@${x.at}ms(${x.lat})`).join(' -> ')}`);
    },
  },
  {
    order: 15, row: 15, id: 'sigterm-listen', timeoutMs: 60000,
    title: 'SIGTERM with a listen stream open: exits within 3 s',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } });
      await g.start();
      await fullList(g, 4);
      const s = await g.open('modern');
      const L = listen(g.url, s, g.token ?? undefined);
      const open = await waitFor(() => L.status === 200 || null, 5000, 50);
      ctx.check('listen stream is open before SIGTERM', !!open, L.info);
      const t0 = now();
      g.kill('SIGTERM');
      const exited = await Promise.race([g.proc.exited.then(() => true), sleep(15000).then(() => false)]);
      const took = ms(t0);
      ctx.metric('exitMs', exited ? took : null);
      ctx.check('process exits within 3 s', exited && took <= 3000, exited ? `${took} ms` : 'still running after 15 s');
      L.close();
      ctx.docResult('10 s (S2 app, systemd stop timeout)', exited && took >= 8000, exited ? `exited after ${took} ms` : 'still running after 15 s');
    },
  },
];
void jsonText; void waitPort; void median; void P;
