// Section 10 rows 1-3: config handling.
import { join } from 'node:path';
import { P } from '../harness/env.mjs';
import { alphaCfg, betaCfg, betaLegacyCfg, pidOf, spawnCount } from '../lib/fixtures.mjs';
import { ALPHA_BETA_TOOLS, fullList, jsonText, sameSet, textOf, toolNames } from '../lib/helpers.mjs';
import { callTool } from '../lib/mcp.mjs';
import { renderConfig } from '../lib/target.mjs';
import { ms, now, sleep, waitFor } from '../lib/util.mjs';
import { waitPort } from '../lib/http.mjs';

export const scenarios = [
  {
    order: 1, row: 1, id: 'config-reject', timeoutMs: 90000,
    title: 'truncated JSON, "_" name, unknown key: process survives, previous config kept, config: rejected',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const good = { upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } };
      const g = ctx.gateway(good);
      await g.start();
      const base = await fullList(g, 4);
      ctx.check('baseline list has 4 tools', sameSet(base, ALPHA_BETA_TOOLS), base.join(','));
      const text = renderConfig(good);
      const cases = [
        ['truncated', () => g.writeRaw(text.slice(0, Math.floor(text.length * 0.6)))],
        ['underscore-name', () => g.writeConfig({ upstreams: { ...good.upstreams, bad_name: alphaCfg() } })],
        ['unknown-key', () => g.writeConfig({ upstreams: { ...good.upstreams, alpha: { ...alphaCfg(), comand: 'x' } } })],
      ];
      const exits = {};
      for (const [name, apply] of cases) {
        const before = g.events().filter((e) => e.event === 'config_rejected').length;
        const t0 = now();
        apply();
        const died = await Promise.race([g.proc.exited.then(() => true), sleep(1500).then(() => false)]);
        exits[name] = died ? ms(t0) : null;
        ctx.metric(`${name}.exitMs`, exits[name]);
        ctx.check(`${name}: process stays alive`, !died, died ? `exited after ${ms(t0)} ms` : '');
        if (died) { g.writeConfig(good); await g.start(); continue; }
        const names = await fullList(g, 4, 3000);
        ctx.check(`${name}: previous config kept`, sameSet(names, ALPHA_BETA_TOOLS), names.join(','));
        const h = await g.healthz();
        ctx.check(`${name}: healthz config rejected`, h.json?.config === 'rejected', `healthz=${h.status} config=${h.json?.config}`);
        ctx.check(`${name}: config_rejected logged`, g.events().filter((e) => e.event === 'config_rejected').length > before);
        g.writeConfig(good);
        const back = await waitFor(async () => (await g.healthz()).json?.config === 'ok', 3000, 100);
        ctx.check(`${name}: valid file accepted again (config ok)`, !!back);
      }
      // The table says "exit within 0.5 s" for the spike. Truncated JSON and the "_" name are the two cases the review ran.
      const within = (n) => exits[n] !== null && exits[n] <= 1000;
      ctx.docResult('process exits within 0.5 s (truncated JSON, "_" name)', within('truncated') && within('underscore-name'),
        `exit ms: truncated=${exits.truncated}, underscore=${exits['underscore-name']}, unknown-key=${exits['unknown-key']} (null = survived)`);
    },
  },
  {
    order: 2, row: 2, id: 'typo-restart', timeoutMs: 60000,
    title: 'restart with a broken file: boots from last-good, config: rejected',
    async run(ctx) {
      await ctx.http('alpha', P.alpha);
      const good = { upstreams: { alpha: alphaCfg(), beta: betaCfg(join(ctx.tmp, 'beta.log')) } };
      const g = ctx.gateway(good);
      await g.start();
      const base = await fullList(g, 4);
      ctx.check('first run applies the good config', sameSet(base, ALPHA_BETA_TOOLS), base.join(','));
      await sleep(300); // last-good is written after a successful apply
      await g.stop();
      const text = renderConfig(good);
      g.writeRaw(text.slice(0, Math.floor(text.length * 0.6)));
      await g.start({ wait: false });
      const up = await Promise.race([waitPort(g.port, 10000), g.proc.exited.then(() => false)]);
      ctx.check('starts although the file is broken', up, up ? '' : `exit=${JSON.stringify(g.proc.exitInfo())}`);
      if (up) {
        const names = await fullList(g, 4, 10000);
        ctx.check('serves the last-good upstreams', sameSet(names, ALPHA_BETA_TOOLS), names.join(','));
        const h = await g.healthz();
        ctx.check('healthz config rejected', h.json?.config === 'rejected', `healthz=${h.status} config=${h.json?.config}`);
      }
      ctx.docResult('no spike result in the table', null, up ? 'started' : `did not start (exit ${JSON.stringify(g.proc.exitInfo())})`);
    },
  },
  {
    order: 3, row: 3, id: 'edit-upstream', timeoutMs: 90000,
    title: 'URL and args edits are applied; unchanged entries are not respawned',
    async run(ctx) {
      await ctx.http('alpha', P.alpha, { ALPHA_NAME: 'alpha' });
      await ctx.http('alpha', P.gamma, { ALPHA_NAME: 'alpha2' }, 'alpha2');
      const betaLog = join(ctx.tmp, 'beta.log');
      const keepLog = join(ctx.tmp, 'keep.log');
      const spec = (over = {}) => ({ upstreams: { alpha: alphaCfg(P.alpha), beta: betaCfg(betaLog), keep: betaLegacyCfg(keepLog), ...over } });
      const g = ctx.gateway(spec());
      await g.start();
      const names = await fullList(g, 6);
      ctx.check('baseline list has 6 tools', names.length === 6, names.join(','));
      const source = async () => jsonText(await callTool(await g.open('modern'), 'alpha_status'))?.source;
      const pid = async (tool) => pidOf(textOf(await callTool(await g.open('modern'), tool, tool.endsWith('echo') ? { text: 'x' } : {})));
      const beta0 = await pid('beta_status');
      const keep0 = await pid('keep_status');
      ctx.check('baseline alpha is alpha', (await source()) === 'alpha');
      // edit 1: URL of an existing upstream
      g.writeConfig(spec({ alpha: alphaCfg(P.gamma) }));
      const urlApplied = await waitFor(async () => (await source()) === 'alpha2', 5000, 150);
      ctx.check('URL edit applied (alpha now answers from the second server)', !!urlApplied, `source=${await source()}`);
      // edit 2: args of an existing stdio upstream
      const edited = betaCfg(betaLog);
      edited.args = [...edited.args, '--edited'];
      g.writeConfig(spec({ alpha: alphaCfg(P.gamma), beta: edited }));
      const argsApplied = await waitFor(async () => { const p = await pid('beta_status'); return p && p !== beta0 ? p : null; }, 6000, 200);
      ctx.check('args edit applied (beta respawned with a new pid)', !!argsApplied, `pid ${beta0} -> ${await pid('beta_status')}`);
      await sleep(500);
      ctx.check('unchanged entry not respawned (keep spawn count 1)', spawnCount(keepLog) === 1, `spawns=${spawnCount(keepLog)}`);
      ctx.check('unchanged entry keeps its pid', (await pid('keep_status')) === keep0);
      ctx.check('edited entry respawned exactly once', spawnCount(betaLog) === 2, `spawns=${spawnCount(betaLog)}`);
      ctx.docResult('edits to existing upstreams are ignored', !urlApplied && !argsApplied, `urlApplied=${!!urlApplied} argsApplied=${!!argsApplied}`);
    },
  },
];
