// Where relief finds things (design 6.2, 8). Nothing here holds the token longer than the call that reads it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Limits } from './model/fact.ts';
import { DEFAULT_LIMITS } from './model/threshold.ts';

export const DEFAULT_TOWER_URL = 'http://127.0.0.1:4800/mcp';
export const DEFAULT_PORT = 4815;

export type Paths = { tokenFile: string; reliefJson: string; edgeJson: string; stateDir: string };

/** Same lookup as tower's config.ts: TOWER_CONFIG names tower.json, and the token sits next to it. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const towerJson = env.TOWER_CONFIG ?? join(configHome, 'tower/tower.json');
  return {
    tokenFile: join(dirname(towerJson), 'token'),
    reliefJson: join(env.RELIEF_CONFIG ?? join(configHome, 'relief'), 'relief.json'),
    edgeJson: join(env.RELIEF_CONFIG ?? join(configHome, 'relief'), 'edge.json'),
    stateDir: env.RELIEF_STATE ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'relief'),
  };
}

/** Same rule as tower: trimmed, and shorter than 32 characters counts as absent. */
export function readToken(file: string): string | null {
  try {
    const t = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    return t.length >= 32 ? t : null;
  } catch { return null; }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The bearer never leaves the machine: anything but a plain loopback URL is refused. */
export function loopbackUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('towerUrl is not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('towerUrl must be http or https');
  if (!LOOPBACK.has(u.hostname)) throw new Error('towerUrl must be a loopback address');
  if (u.username || u.password || u.search || u.hash) throw new Error('towerUrl must carry no credentials or query');
  return u;
}

/** HTTPS only, so nothing on the way can answer for the service. Plain http stays on loopback, where the tests' mock lives. */
export function publicIpUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('publicIpUrl is not a URL'); }
  const local = LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('publicIpUrl must be https');
  if (u.username || u.password) throw new Error('publicIpUrl must carry no credentials');
  return u.href;
}

const ReliefJson = z.strictObject({ towerUrl: z.string().optional(), publicIpUrl: z.unknown().optional(), thresholds: z.unknown().optional(), healthIntervalS: z.unknown().optional() });

const percent = z.number().gt(0).max(100);
/** Percent, as a person writes it. `sustainS` is a length of time: 15 s is one period of the fast loop, so anything shorter is the spike the rule exists to ignore. */
const ThresholdsJson = z.strictObject({ cpu: percent.optional(), mem: percent.optional(), disk: percent.optional(), sustainS: z.number().int().min(15).max(900).optional() });
const HealthS = z.number().int().min(10).max(3600);

export type Config = { towerUrl: string; publicIpUrl?: string; publicIpError?: string; error?: string; thresholds?: Limits; thresholdsError?: string; healthS?: number; healthError?: string };

/** A bad value here costs its own feature its setting and nothing else: the defaults hold, and `relief check` says so. */
function extras(cfg: z.infer<typeof ReliefJson>): Pick<Config, 'thresholds' | 'thresholdsError' | 'healthS' | 'healthError'> {
  const out: ReturnType<typeof extras> = {};
  if (cfg.thresholds !== undefined) {
    const t = ThresholdsJson.safeParse(cfg.thresholds);
    if (!t.success) out.thresholdsError = 'thresholds 설정 오류';
    else {
      const frac = (v: number | undefined, d: number) => (v === undefined ? d : v / 100);
      out.thresholds = { cpu: frac(t.data.cpu, DEFAULT_LIMITS.cpu), mem: frac(t.data.mem, DEFAULT_LIMITS.mem), disk: frac(t.data.disk, DEFAULT_LIMITS.disk), sustainS: t.data.sustainS ?? DEFAULT_LIMITS.sustainS };
    }
  }
  if (cfg.healthIntervalS !== undefined) {
    const h = HealthS.safeParse(cfg.healthIntervalS);
    if (h.success) out.healthS = h.data; else out.healthError = 'healthIntervalS 설정 오류';
  }
  return out;
}

/** relief.json is optional. A bad file is an error to report, never a reason not to start. */
export function loadConfig(p: Paths): Config {
  let raw: string;
  try { raw = readFileSync(p.reliefJson, 'utf8'); } catch { return { towerUrl: DEFAULT_TOWER_URL }; }
  try {
    const cfg = ReliefJson.parse(JSON.parse(raw));
    const towerUrl = loopbackUrl(cfg.towerUrl ?? DEFAULT_TOWER_URL).href;
    const more = extras(cfg);
    if (cfg.publicIpUrl === undefined) return { towerUrl, ...more };
    // Its own verdict: this field reaches one optional source, and must not stop the reads that have nothing to do with it.
    try { if (typeof cfg.publicIpUrl !== 'string') throw new Error('not text'); return { towerUrl, publicIpUrl: publicIpUrl(cfg.publicIpUrl), ...more }; } catch { return { towerUrl, publicIpError: 'publicIpUrl 설정 오류', ...more }; }
  } catch (e) {
    return { towerUrl: DEFAULT_TOWER_URL, error: e instanceof z.ZodError ? 'relief.json has an unknown or malformed field' : String((e as Error).message).slice(0, 200) };
  }
}
