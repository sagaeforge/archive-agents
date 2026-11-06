// Section 10 rows 16-22: what the merged surface looks like to a client.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NODE, P } from '../harness/env.mjs';
import { alphaCfg, betaCfg, betaLegacyCfg, spawnCount, UPSTREAMS } from '../lib/fixtures.mjs';
import { ALPHA_BETA_TOOLS, fullList, jsonText, textOf, toolNames } from '../lib/helpers.mjs';
import { callTool, isOk, listen } from '../lib/mcp.mjs';
import { connectFetch } from '../lib/http.mjs';
import { HARNESS } from '../lib/paths.mjs';
import { median, now, ms, sleep, waitFor } from '../lib/util.mjs';

const run = promisify(execFile);
const ERAS = ['modern', 'legacy'];
const tools = async (g, era) => (await (await g.open(era, 15000)).call('tools/list', {}, 15000)).json?.result?.tools ?? [];
const anthropicKeys = (t) => Object.keys(t?._meta ?? {}).filter((k) => k.startsWith('anthropic/'));

export const scenarios = [
  {
    order: 16, row: 16, id: 'probe', timeoutMs: 120000,
    title: 'full probe (both eras) still passes; structuredContent, _meta kept; order fixed',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const betaLog = join(ctx.tmp, 'beta.log');
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), beta: betaCfg(betaLog) } });
      await g.start();
      await fullList(g, 4);
      const out = join(ctx.tmp, 'probe.json');
      const args = [join(HARNESS, 'probe.mjs'), g.url, 'both', '--out', out, ...(g.token ? ['--bearer', g.token] : [])];
      try { await run(NODE, args, { timeout: 60000, killSignal: 'SIGKILL' }); } catch (e) { ctx.check('probe.mjs ran', false, String(e.message).slice(0, 100)); return; }
      const rep = JSON.parse(readFileSync(out, 'utf8'));
      const base = [];
      const baseCheck = (name, ok, detail) => { base.push(ok); ctx.check(`base: ${name}`, ok, detail); };
      for (const era of ['legacy', 'modern']) {
        const o = rep[era] ?? {};
        const names = (o.tools ?? []).map((t) => t.name);
        baseCheck(`${era} negotiates ${era === 'legacy' ? '2025-11-25' : '2026-07-28'}`, o.negotiated === (era === 'legacy' ? '2025-11-25' : '2026-07-28'), String(o.negotiated));
        baseCheck(`${era} lists the 4 merged tools in order`, JSON.stringify(names) === JSON.stringify(ALPHA_BETA_TOOLS), names.join(','));
        const st = (o.tools ?? []).find((t) => t.name === 'alpha_status');
        baseCheck(`${era} outputSchema, annotations, _meta kept`, !!st?.hasOutputSchema && st?.annotations?.readOnlyHint === true && !!st?.meta?.['x.spike/marker'], JSON.stringify(st ?? {}).slice(0, 100));
        baseCheck(`${era} structuredContent returned`, o.calls?.alpha_status?.structuredContent?.source === 'alpha', JSON.stringify(o.calls?.alpha_status?.structuredContent));
        baseCheck(`${era} resource_link reads back`, Object.values(o.linkReadback ?? {}).length > 0 && Object.values(o.linkReadback ?? {}).every((v) => v.ok), JSON.stringify(o.linkReadback).slice(0, 100));
        baseCheck(`${era} resources read`, Object.values(o.reads ?? {}).length === 2 && Object.values(o.reads ?? {}).every((v) => v.contents?.[0]?.text), JSON.stringify(Object.keys(o.reads ?? {})));
        baseCheck(`${era} instructions carry both upstreams and fit 4,096 chars`, /ALPHA_INSTRUCTIONS/.test(o.instructions ?? '') && /BETA_INSTRUCTIONS/.test(o.instructions ?? '') && (o.instructions ?? '').length <= 4096, `${(o.instructions ?? '').length} chars`);
        baseCheck(`${era} tool calls succeed`, ['alpha_status', 'alpha_link_doc', 'beta_status', 'beta_beta_echo'].every((n) => o.calls?.[n] && !o.calls[n].isError && o.calls[n].status === 200), JSON.stringify(Object.keys(o.calls ?? {})));
      }
      // Added for tower: the order does not depend on the order of the config file.
      await g.stop();
      g.writeConfig({ upstreams: { beta: betaCfg(betaLog), alpha: alphaCfg() } });
      await g.start();
      await fullList(g, 4);
      const reversed = (await tools(g, 'modern')).map((t) => t.name);
      ctx.check('added: tool order is fixed (alpha first) when the file lists beta first', JSON.stringify(reversed) === JSON.stringify(ALPHA_BETA_TOOLS), reversed.join(','));
      ctx.docResult('probe: all items pass', base.every(Boolean), `${base.filter(Boolean).length}/${base.length} base checks pass`);
    },
  },
  {
    order: 17, row: 17, id: 'meta-anthropic', timeoutMs: 60000,
    title: 'anthropic/* _meta from the upstream is erased; tools outside autoApprove get requiresUserInteraction: true',
    async run(ctx) {
      await ctx.http('mutable', P.alpha);
      const g = ctx.gateway({ upstreams: { mut: { url: `http://127.0.0.1:${P.alpha}/mcp`, uriPrefixes: [], autoApprove: ['read_x'] } } });
      await g.start();
      await fullList(g, 3);
      let passThrough = false;
      for (const era of ERAS) {
        const ts = await tools(g, era);
        const by = Object.fromEntries(ts.map((t) => [t.name, t]));
        const r = by.mut_read_x, w = by.mut_write_x, p = by.mut_plain;
        ctx.check(`${era}: autoApprove tool has no anthropic/* keys`, !!r && anthropicKeys(r).length === 0, JSON.stringify(r?._meta));
        ctx.check(`${era}: autoApprove tool keeps other _meta`, r?._meta?.['x.keep/marker'] === 'read-x', JSON.stringify(r?._meta));
        ctx.check(`${era}: other tool forced to requiresUserInteraction true (upstream said false)`, w?._meta?.['anthropic/requiresUserInteraction'] === true && anthropicKeys(w).length === 1 && w?._meta?.['x.keep/marker'] === 'write-x', JSON.stringify(w?._meta));
        ctx.check(`${era}: tool without _meta also gets true`, p?._meta?.['anthropic/requiresUserInteraction'] === true, JSON.stringify(p?._meta));
        if (era === 'modern') passThrough = r?._meta?.['anthropic/alwaysLoad'] === true;
      }
      ctx.docResult('upstream anthropic/* _meta passes through', passThrough, `alwaysLoad on mut_read_x passes through: ${passThrough}`);
    },
  },
  {
    order: 18, row: 18, id: 'refresh-new-tool', timeoutMs: 60000,
    title: 'a tool that appears on refresh needs confirmation; tools_changed logs names only',
    async run(ctx) {
      const mut = await ctx.http('mutable', P.alpha);
      const g = ctx.gateway({ upstreams: { mut: { url: mut.url, uriPrefixes: [], autoApprove: ['read_x'], refreshIntervalMs: 1000 } } });
      await g.start();
      await fullList(g, 3);
      const s = await g.open('modern');
      const L = listen(g.url, s, g.token ?? undefined);
      await sleep(500);
      await connectFetch(`http://127.0.0.1:${P.alpha}/ctl/add`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      const t0 = now();
      const appeared = await waitFor(async () => (await tools(g, 'modern')).find((t) => t.name === 'mut_vm_stop') ?? null, 8000, 200);
      ctx.metric('appearedAfterMs', appeared ? ms(t0) : null);
      ctx.check('the new tool is listed', !!appeared, appeared ? `after ${ms(t0)} ms` : 'not listed within 8 s');
      ctx.check('it needs confirmation: requiresUserInteraction true', appeared?._meta?.['anthropic/requiresUserInteraction'] === true, JSON.stringify(appeared?._meta));
      ctx.check('its upstream alwaysLoad is erased', !!appeared && anthropicKeys(appeared).length === 1, JSON.stringify(appeared?._meta));
      ctx.check('list_changed reached the listening session', L.seen.some((e) => e.method === 'notifications/tools/list_changed'), L.seen.map((e) => e.method).join(','));
      await sleep(500);
      const ev = g.events().filter((e) => e.event === 'tools_changed');
      ctx.check('tools_changed logged with the tool name', ev.some((e) => JSON.stringify(e).includes('vm_stop')), ev.map((e) => JSON.stringify(e)).join(' ').slice(0, 120) || 'no tools_changed event');
      ctx.check('no log line carries the description text', !g.logLines().some((l) => l.includes('SECRET-DESCRIPTION-MARKER')), '');
      L.close();
      ctx.docResult('not applicable in the table', null, `new tool listed=${!!appeared}`);
    },
  },
  {
    order: 19, row: 19, id: 'down-tools-kept', timeoutMs: 60000,
    title: 'tools of a down upstream stay listed; calling them returns isError',
    async run(ctx) {
      const alpha = await ctx.http('alpha', P.alpha);
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } });
      await g.start();
      await fullList(g, 4);
      const s0 = await g.open('modern');
      const bpid = Number(/pid=(\d+)/.exec(textOf(await callTool(s0, 'beta_beta_echo', { text: 'x' })))?.[1]);
      await alpha.stop();
      await sleep(200); // the S1 sample time
      const s = await g.open('modern', 20000);
      const names = toolNames(await s.call('tools/list', {}, 20000)) ?? [];
      ctx.check('HTTP upstream down: its tools stay in the list', names.includes('alpha_status') && names.includes('alpha_link_doc'), names.join(','));
      const c = await callTool(s, 'alpha_status', {}, 20000);
      ctx.check('HTTP upstream down: the call returns an isError result', c.json?.result?.isError === true, `${c.json?.error ? `rpc ${c.json.error.code}` : c.status} ${textOf(c).slice(0, 60)}`);
      ctx.check('HTTP upstream down: the error names it', /alpha/.test(textOf(c)), textOf(c).slice(0, 80));
      process.kill(bpid, 'SIGKILL');
      await sleep(100);
      const names2 = toolNames(await s.call('tools/list', {}, 20000)) ?? [];
      ctx.check('stdio child killed: its tools stay in the list', names2.includes('beta_status') && names2.includes('beta_beta_echo'), names2.join(','));
      ctx.docResult('tools of a down upstream leave the list', !names.includes('alpha_status'), `after HTTP stop: ${names.join(',')}; after stdio kill: ${names2.join(',')}`);
    },
  },
  {
    order: 20, row: 20, id: 'spawn-count', timeoutMs: 90000,
    title: 'stdio spawns per call: 0 (dual-era and legacy-only children)',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const betaLog = join(ctx.tmp, 'beta.log');
      const keepLog = join(ctx.tmp, 'keep.log');
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), beta: betaCfg(betaLog), keep: betaLegacyCfg(keepLog) } });
      await g.start();
      await fullList(g, 6);
      await sleep(500);
      const b0 = spawnCount(betaLog), k0 = spawnCount(keepLog);
      ctx.check('one child each after start', b0 === 1 && k0 === 1, `beta=${b0} legacy-only=${k0}`);
      const lat = [];
      for (const era of ERAS) {
        const s = await g.open(era, 15000);
        for (let i = 0; i < 20; i++) {
          for (const [tool, args] of [['beta_status', {}], ['beta_beta_echo', { text: 'x' }], ['keep_status', {}], ['alpha_status', {}]]) {
            const r = await callTool(s, tool, args, 15000);
            if (tool === 'keep_status') lat.push(r.ms);
            if (!isOk(r)) ctx.check(`${era} ${tool} call ok`, false, `${r.status} ${r.raw ?? ''}`);
          }
          await s.call('tools/list', {}, 15000);
          await s.call('resources/read', { uri: 'beta://notes/1' }, 15000);
        }
      }
      await sleep(500);
      const b1 = spawnCount(betaLog), k1 = spawnCount(keepLog);
      ctx.metric('spawnsDuring', { beta: b1 - b0, legacyOnly: k1 - k0 }); ctx.metric('legacyOnlyCallP50Ms', median(lat));
      ctx.check('0 spawns during 240 calls on the dual-era child', b1 === b0, `${b1 - b0} extra`);
      ctx.check('0 spawns during 240 calls on the legacy-only child', k1 === k0, `${k1 - k0} extra`);
      ctx.docResult('0 per call', b1 === b0 && k1 === k0, `extra spawns: beta ${b1 - b0}, legacy-only ${k1 - k0}`);
    },
  },
  {
    order: 21, row: 21, id: 'relay', timeoutMs: 150000,
    title: 'progress, cancel, 70 s call, Korean URI, input_required pass through',
    async run(ctx) {
      const events = join(ctx.tmp, 'alpha-events.log');
      writeFileSync(events, '');
      await ctx.http('alpha', P.alpha, { ALPHA_EXTRA: '1', ALPHA_EVENTS: events });
      const g = ctx.gateway({ upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } });
      await g.start();
      await fullList(g, 4);
      const bearer = g.token ?? '-';
      const script = (f, ...a) => run(NODE, [join(UPSTREAMS, f), g.url, bearer, ...a], { timeout: 125000, killSignal: 'SIGKILL' }).then((r) => r.stdout, (e) => `FAILED ${String(e.stdout ?? '')} ${String(e.message).slice(0, 100)}`);
      const longP = script('_relay.mjs', 'long', events);
      const shortOut = await script('_relay.mjs', 'short', events);
      const mrtrOut = await script('_mrtr.mjs');
      const progress = Number(/progress notifications received: (\d+)/.exec(shortOut)?.[1] ?? -1);
      ctx.check('progress notifications relayed (about 5 sent)', progress >= 4, `${progress} received`);
      ctx.check('cancel reaches the upstream', /upstream saw cancel=true/.test(shortOut), shortOut.split('\n').find((l) => l.startsWith('cancel')) ?? shortOut.slice(0, 100));
      ctx.check('Korean URI listed and read', /read ok, body=korean-uri-body/.test(shortOut), shortOut.split('\n').find((l) => l.startsWith('korean')) ?? shortOut.slice(0, 100));
      ctx.check('input_required round trip', /result=confirmed/.test(mrtrOut), mrtrOut.trim().slice(0, 100));
      const longOut = await longP;
      ctx.check('70 s call completes', /70 s call: ok after/.test(longOut), longOut.trim().slice(0, 120));
      ctx.docResult('pass', progress >= 4 && /cancel=true/.test(shortOut) && /korean-uri-body/.test(shortOut) && /confirmed/.test(mrtrOut) && /70 s call: ok/.test(longOut), `progress=${progress}; ${longOut.trim().slice(0, 60)}`);
    },
  },
  {
    order: 22, row: 22, id: 'prompts-templates', timeoutMs: 60000,
    title: 'prompts/get and resources/templates/list are exercised through the merge',
    async run(ctx) {
      await ctx.http('rich', P.alpha);
      const g = ctx.gateway({ upstreams: { rich: { url: `http://127.0.0.1:${P.alpha}/mcp`, uriPrefixes: ['rich://'] } } });
      await g.start();
      await fullList(g, 1);
      const seen = [];
      for (const era of ERAS) {
        const s = await g.open(era, 15000);
        const pl = await s.call('prompts/list', {}, 15000);
        const pn = (pl.json?.result?.prompts ?? []).map((p) => p.name);
        ctx.check(`${era}: prompts/list has rich_hello`, pn.includes('rich_hello'), pn.join(',') || JSON.stringify(pl.json?.error ?? pl.raw));
        const pg = await s.call('prompts/get', { name: 'rich_hello', arguments: { name: 'x' } }, 15000);
        const txt = pg.json?.result?.messages?.[0]?.content?.text;
        ctx.check(`${era}: prompts/get routes to the owner`, txt === 'rich-hello:x', txt ?? JSON.stringify(pg.json?.error ?? pg.raw));
        const tl = await s.call('resources/templates/list', {}, 15000);
        const tpl = (tl.json?.result?.resourceTemplates ?? []).map((t) => t.uriTemplate);
        ctx.check(`${era}: resources/templates/list has rich://{id}/doc`, tpl.includes('rich://{id}/doc'), tpl.join(',') || JSON.stringify(tl.json?.error ?? tl.raw));
        const rd = await s.call('resources/read', { uri: 'rich://42/doc' }, 15000);
        ctx.check(`${era}: a templated URI reads`, rd.json?.result?.contents?.[0]?.text === 'rich-doc-body:42', JSON.stringify(rd.json?.error ?? rd.json?.result?.contents ?? rd.raw).slice(0, 100));
        seen.push(txt, tpl.length);
      }
      ctx.docResult('not run in S1', null, `prompts/get text=${seen[0]} templates=${seen[1]}`);
    },
  },
];

void fullList; void jsonText; void median;
