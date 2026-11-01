// Where relief finds things (design 6.2, 8). Nothing here holds the token longer than the call that reads it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_TOWER_URL = 'http://127.0.0.1:4800/mcp';
export const DEFAULT_PORT = 4815;

export type Paths = { tokenFile: string; reliefJson: string; stateDir: string };

/** Same lookup as tower's config.ts: TOWER_CONFIG names tower.json, and the token sits next to it. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const towerJson = env.TOWER_CONFIG ?? join(configHome, 'tower/tower.json');
  return {
    tokenFile: join(dirname(towerJson), 'token'),
    reliefJson: join(env.RELIEF_CONFIG ?? join(configHome, 'relief'), 'relief.json'),
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

const ReliefJson = z.strictObject({ towerUrl: z.string().optional() });

/** relief.json is optional. A bad file is an error to report, never a reason not to start. */
export function loadConfig(p: Paths): { towerUrl: string; error?: string } {
  let raw: string;
  try { raw = readFileSync(p.reliefJson, 'utf8'); } catch { return { towerUrl: DEFAULT_TOWER_URL }; }
  try {
    const cfg = ReliefJson.parse(JSON.parse(raw));
    return { towerUrl: loopbackUrl(cfg.towerUrl ?? DEFAULT_TOWER_URL).href };
  } catch (e) {
    return { towerUrl: DEFAULT_TOWER_URL, error: e instanceof z.ZodError ? 'relief.json has an unknown or malformed field' : String((e as Error).message).slice(0, 200) };
  }
}
