// Upstream fixtures: HTTP stand-ins started as processes, stdio stand-ins described as config entries.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE, P } from '../harness/env.mjs';
import { REGRESSION } from './target.mjs';
import { waitPort } from './http.mjs';
import { spawnTracked } from './proc.mjs';

export const UPSTREAMS = join(REGRESSION, 'upstreams');
export const ASSETS = join(REGRESSION, 'review-assets');
const TEST_DIR = join(REGRESSION, '..');
export const PY1 = join(TEST_DIR, '.venv-mcp-1.30.0/bin/python');
export const PY2 = join(TEST_DIR, '.venv-mcp-2.3.0/bin/python');
export const HTTP_FIXTURES = { alpha: ['alpha.mjs', 'ALPHA_PORT'], mutable: ['mutable.mjs', 'MUTABLE_PORT'], rich: ['rich.mjs', 'RICH_PORT'], raw: ['raw-http.mjs', 'RAW_PORT'], modern: ['modern.mjs', 'MODERN_PORT'] };

// Start an HTTP upstream on `port`. Resolves once it accepts connections.
export async function startHttp(tmp, kind, port, env = {}, tag = kind) {
  const [file, portVar] = HTTP_FIXTURES[kind];
  const proc = spawnTracked(NODE, [join(UPSTREAMS, file)], { env: { [portVar]: String(port), ...env }, cwd: tmp, log: join(tmp, `${tag}-${port}.log`) });
  if (!(await Promise.race([waitPort(port, 8000), proc.exited.then(() => false)]))) throw new Error(`${kind} fixture did not open ${port}: ${proc.readLog().slice(-200)}`);
  return { kind, port, proc, pid: proc.pid, url: `http://127.0.0.1:${port}/mcp`, stop: () => proc.stop(), kill: (s) => proc.signalLeader(s) };
}

// stdio stand-ins, as tower.json upstream entries. `log` receives one JSON line per spawn and exit.
export const betaCfg = (log, extra = {}) => ({ command: NODE, args: [join(UPSTREAMS, 'beta.mjs')], env: { BETA_SPAWN_LOG: log }, uriPrefixes: ['beta://'], ...extra });
// Runs next to betaCfg in rows 3 and 20, and its URI is the same one: only one upstream may own beta://, so this one owns nothing.
export const betaLegacyCfg = (log, extra = {}) => ({ command: NODE, args: [join(UPSTREAMS, 'beta-legacy.mjs')], env: { BETA_SPAWN_LOG: log }, uriPrefixes: [], ...extra });
export const alphaCfg = (port = P.alpha, extra = {}) => ({ url: `http://127.0.0.1:${port}/mcp`, uriPrefixes: ['doc://alpha/'], ...extra });
export const realPyCfg = (python, log, extra = {}) => ({ command: python, args: [join(ASSETS, 'realpy.py')], env: { SPAWN_LOG: log }, uriPrefixes: [], ...extra });
export const slowPyCfg = (python, seconds, extra = {}) => ({ command: python, args: [join(ASSETS, 'slowpy.py')], env: { SLOW_S: String(seconds) }, uriPrefixes: [], ...extra });
export const realTsCfg = (log, extra = {}) => ({ command: NODE, args: [join(ASSETS, 'realts.mjs')], env: { SPAWN_LOG: log }, uriPrefixes: [], ...extra });
export const rawCfg = (env = {}, extra = {}) => ({ command: NODE, args: [join(UPSTREAMS, 'raw-stdio.mjs')], env, uriPrefixes: [], ...extra });

export function spawnCount(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"spawn"')).length; } catch { return 0; }
}
export function spawnPids(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"spawn"')).map((l) => JSON.parse(l).pid); } catch { return []; }
}
export const pidOf = (text) => Number(/pid=(\d+)/.exec(text ?? '')?.[1]);
