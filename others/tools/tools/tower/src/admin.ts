// /admin: what `tower status` and `tower restart` read. The bearer guard sits in front of this.
import { existsSync, statSync } from 'node:fs';
import type { Hono } from 'hono';
import { ENV_PATH, TOKEN_PATH } from './config.js';
import { faults, redactRing } from './log.js';
import { mergedInstructions, owns, sorted, upstreams } from './merge.js';
import { LIMITS, type Upstream } from './upstream.js';

const NAME_MAX = 103; // Claude Code drops tool names over 128 characters; mcp__plugin_tower_tower__ takes 25.

function warningsOf(u: Upstream) {
  const { tools, resources, resourceTemplates } = u.lists;
  const hidden = resources.filter((r) => !owns(u, r.uri)).length + resourceTemplates.filter((t) => !owns(u, t.uriTemplate.split('{')[0]!)).length;
  const long = tools.filter((t) => u.cfg.name.length + 1 + t.name.length > NAME_MAX).length;
  const cut = !mergedInstructions().includes(u.client?.getInstructions() ?? '');
  const notes = [hidden && `${hidden} resources outside uriPrefixes hidden`, long && `${long} tool names over ${NAME_MAX} characters`, cut && 'instructions were cut'];
  return notes.filter(Boolean).map((note) => `${u.cfg.name}: ${note}`);
}

const countsOf = ({ lists: { tools, prompts, resources } }: Upstream) => ({ tools: tools.length, prompts: prompts.length, resources: resources.length });
const healthOf = (u: Upstream) => ({ state: u.state, snapshot: !!u.toolHashes, restarts: u.attempt - 1, failures: u.failures, lastError: u.lastError });
const statusOf = (u: Upstream) => ({ ...healthOf(u), era: u.era, pid: u.stdio?.pid ?? undefined, toolsChangedAt: u.toolsChangedAt, ...countsOf(u) });

const tooOpen = (file: string) => (existsSync(file) && statSync(file).mode & 0o077 ? [`${file}: mode is wider than 600`] : []);

export function mountAdmin(app: Hono, base: () => { routes: Record<string, { path: string; proxy: string }> } & Record<string, unknown>) {
  const status = () => ({
    ...base(),
    uptimeS: Math.round(process.uptime()),
    routes: Object.fromEntries(Object.entries(base().routes).map(([name, { path, proxy }]) => [name, { path, proxy }])), // requestHeaders hold substituted values.
    upstreams: Object.fromEntries(sorted().map((u) => [u.cfg.name, statusOf(u)])),
    warnings: [...[...faults].map(([name, why]) => `${name}: ${why}`), ...tooOpen(ENV_PATH), ...tooOpen(TOKEN_PATH), ...sorted().flatMap(warningsOf)],
  });
  app.get('/admin/status', (c) => c.json(status()));
  app.get('/admin/upstreams/:name', (c) => {
    const u = upstreams.get(c.req.param('name'));
    if (!u) return c.json({ error: 'unknown upstream' }, 404);
    return c.json({ ...status(), stderrNote: 'untrusted upstream output', stderr: redactRing(u.stderr, u.stderr.length === LIMITS.ringBytes) });
  });
  app.post('/admin/upstreams/:name/restart', async (c) => {
    const u = upstreams.get(c.req.param('name'));
    if (!u) return c.json({ error: 'unknown upstream' }, 404);
    await u.apply(u.cfg, true);
    return c.json(statusOf(u));
  });
}
