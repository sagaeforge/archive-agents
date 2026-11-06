// Per-scenario context: a temp dir, a check collector and a cleanup stack.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { P, RUN_DIR } from '../harness/env.mjs';
import { startHttp } from './fixtures.mjs';
import { createGateway, TARGET } from './target.mjs';
import { short } from './util.mjs';

export function makeCtx(id) {
  mkdirSync(RUN_DIR, { recursive: true });
  const tmp = mkdtempSync(join(RUN_DIR, `${id}-`));
  const checks = [];
  const metrics = {};
  const cleanups = [];
  const ctx = {
    id, tmp, target: TARGET, P, checks, metrics, doc: null,
    // check(name, ok, detail): the row passes only if every check passes
    check(name, ok, detail = '') { checks.push({ name, ok: !!ok, detail: short(detail, 160) }); return !!ok; },
    metric(key, value) { metrics[key] = value; return value; },
    // What the spike column of the section 10 table says, and whether this run agrees. Only meaningful for target=spike.
    // match: true | false | null (null = the table has no spike result for this row, or it cannot be compared)
    docResult(expected, match, observed) { ctx.doc = { expected, match, observed: short(observed, 200) }; },
    onCleanup(fn) { cleanups.unshift(fn); },
    gateway(spec, opts = {}) {
      const g = createGateway({ tmp, spec, ...opts });
      ctx.onCleanup(() => g.stop(2000));
      return g;
    },
    async http(kind, port, env, tag) {
      const u = await startHttp(tmp, kind, port, env, tag);
      ctx.onCleanup(() => u.stop());
      return u;
    },
    async cleanup() {
      for (const fn of cleanups) { try { await fn(); } catch {} }
      if (!process.env.TOWER_TEST_KEEP) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
    },
  };
  return ctx;
}
