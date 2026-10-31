// tower.json, env and token: parse, validate, resolve ${VAR}, keep last-good, watch for saves.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, type Stats, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { attempt, secrets } from './log.js';

export const CONFIG_PATH = process.env.TOWER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tower/tower.json');
export const TOKEN_PATH = join(dirname(CONFIG_PATH), 'token');
export const ENV_PATH = join(dirname(CONFIG_PATH), 'env');
const LAST_GOOD_PATH = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'tower/last-good.json');
export const CALL_MAX_MS = 1_800_000; // Below the registration timeout of section 8, so the model sees tower's error.

const text = z.string().optional();
const stringMap = z.record(z.string(), z.string()).optional();
const texts = z.array(z.string());
const connection = { command: text, args: texts.optional(), cwd: text, env: stringMap, url: text, headers: stringMap, type: z.enum(['stdio', 'http']).optional() };
const policy = { enabled: z.boolean().default(true), autoApprove: texts.default([]), uriPrefixes: z.array(z.string().min(1)).optional() };
// Above 2^31 - 1 Node fires a timer after 1 ms.
const timing = { refreshIntervalMs: z.int().nonnegative().max(2 ** 31 - 1).default(30_000), callTimeoutMs: z.int().positive().max(CALL_MAX_MS).default(300_000) };
const upstreamSchema = z.strictObject({ ...connection, ...policy, ...timing, note: text });
const routeSchema = z.strictObject({ path: z.string().regex(/^\/[a-z0-9-]+$/), proxy: z.string(), requestHeaders: stringMap, note: text });
const fileSchema = z.strictObject({ upstreams: z.record(z.string(), upstreamSchema).default({}), routes: z.record(z.string(), routeSchema).default({}) });
export type UpstreamConfig = z.output<typeof upstreamSchema> & { name: string; fingerprint: string };
export type Config = { upstreams: Record<string, UpstreamConfig>; routes: Record<string, z.output<typeof routeSchema>>; source: string; hash: string };

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function parseConfig(source: string, vars: NodeJS.Dict<string>): Config {
  const file = fileSchema.parse(JSON.parse(source));
  const errors: string[] = [];
  const resolve = (values: Record<string, string> = {}, at: string) => JSON.parse(JSON.stringify(values).replace(/\$\{(\w+)\}/g, (_ref, name: string) => {
    const found = vars[name] ?? process.env[name];
    if (found === undefined) errors.push(`${at}: \${${name}} is not set`);
    if (found && found.length >= 8) secrets.add(found); // A shorter value is a flag or a number. Replacing it would rewrite timestamps and hashes in the log.
    if (/eaders$/.test(at) && /[^\t\x20-\xff]/.test(found ?? '')) errors.push(`${at}: \${${name}} cannot be a header value`); // Without the value: it is a secret.
    return JSON.stringify(found ?? '').slice(1, -1);
  }));
  const checkTarget = (target: string, at: string) => {
    const url = URL.parse(target);
    if (target.includes('${') || !url || !/^https?:$/.test(url.protocol)) errors.push(`${at}: needs a plain http(s) URL`);
    if (url?.username || url?.password) errors.push(`${at}: userinfo is not allowed`);
    if (url && [...url.searchParams.keys()].some((k) => /^(token|api_?key|access_token|secret|password|key)$/i.test(k))) errors.push(`${at}: secret in the query string`);
  };

  const upstreams: Config['upstreams'] = {};
  for (const [name, u] of Object.entries(file.upstreams)) {
    const at = `upstreams.${name}`;
    if (!/^[a-z0-9-]{1,32}$/.test(name)) errors.push(`${at}: name must match ^[a-z0-9-]{1,32}$`);
    if (!u.command === !u.url) errors.push(`${at}: set exactly one of command and url`);
    if (!u.enabled) continue;
    if ([u.command, u.cwd, ...(u.args ?? [])].some((v) => v?.includes('${'))) errors.push(`${at}: \${ only belongs in env and headers`);
    if ([u.command, u.cwd].some((path) => path && !isAbsolute(path))) errors.push(`${at}: command and cwd must be absolute`);
    if (u.command && !((statSync(u.command, { throwIfNoEntry: false })?.mode ?? 0) & 0o111)) errors.push(`${at}: command is not executable`);
    if (u.url) checkTarget(u.url, `${at}.url`);
    for (const [key, value] of Object.entries(u.headers ?? {}))
      if (/^(proxy-)?authorization$|^cookie$|^x-api-key$/i.test(key) && !/\$\{\w+\}/.test(value)) errors.push(`${at}.headers.${key}: needs a \${VAR}`);
    const env = resolve(u.env, `${at}.env`);
    const headers = resolve(u.headers, `${at}.headers`);
    upstreams[name] = { ...u, name, env, headers, fingerprint: sha256(JSON.stringify([u.command, u.args, u.cwd, env, u.url, headers])) };
  }
  const claims = Object.entries(upstreams).flatMap(([name, u]) => (u.uriPrefixes ?? []).map((prefix) => ({ name, prefix })));
  for (const a of claims) for (const b of claims) if (a.name !== b.name && a.prefix.startsWith(b.prefix)) errors.push(`uriPrefixes overlap: ${a.name} and ${b.name}`);

  const routes: Config['routes'] = {};
  const paths = ['/mcp', '/healthz', '/admin', ...Object.values(file.routes).map((r) => r.path)];
  for (const [name, r] of Object.entries(file.routes)) {
    const at = `routes.${name}`;
    if (paths.indexOf(r.path) !== paths.lastIndexOf(r.path)) errors.push(`${at}: path ${r.path} is reserved or taken`);
    checkTarget(r.proxy, `${at}.proxy`);
    routes[name] = { ...r, requestHeaders: resolve(r.requestHeaders, `${at}.requestHeaders`) };
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { upstreams, routes, source, hash: sha256(source).slice(0, 12) };
}

export const loadConfig = (path = CONFIG_PATH) => parseConfig(readFileSync(path, 'utf8'), existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {});

export const lastGood = () => attempt('last_good', () => loadConfig(LAST_GOOD_PATH)) ?? parseConfig('{}', {});

export function saveLastGood(source: string) {
  const tmp = `${LAST_GOOD_PATH}.${randomUUID()}`; // Exclusive under a fresh name: a leftover cannot lend its mode, and a symlink cannot redirect the write.
  mkdirSync(dirname(LAST_GOOD_PATH), { recursive: true, mode: 0o700 });
  chmodSync(dirname(LAST_GOOD_PATH), 0o700);
  writeFileSync(tmp, source, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, LAST_GOOD_PATH);
}

export function readToken() {
  const token = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, 'utf8').trim() : '';
  return token.length >= 32 ? token : null;
}

// Any save of tower.json, env or token, polled by path. A watch on the directory ends with its inode and can run out of inotify slots.
export function watchConfig(onSave: () => void) {
  let timer: NodeJS.Timeout | undefined;
  // Node also calls this once for a file that does not exist yet, with both sides zeroed: nothing was saved.
  const saved = (now: Stats, before: Stats) => void (now.ctimeMs !== before.ctimeMs && (clearTimeout(timer), (timer = setTimeout(onSave, 100))));
  for (const file of [CONFIG_PATH, ENV_PATH, TOKEN_PATH]) watchFile(file, { interval: 100 }, saved);
}
