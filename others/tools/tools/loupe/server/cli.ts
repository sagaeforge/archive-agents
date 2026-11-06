// The terminal-only commands of design v2 6.2 and 6.5. Each refuses to run without a terminal on both stdin and stdout, so no
// script, pipe or agent can set the client secret, the allowed account or the break-glass password, or open the break-glass path.
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword, MIN_LENGTH, OPEN_MS } from './auth/breakglass.ts';
import { configDir, FILES, readPrivateJson, writePrivateJson, type AuthFile, type ClientFile } from './auth/files.ts';
import { check } from './auth/guard.ts';
import { GOOGLE_ISSUER, LoginFailure, Oidc } from './auth/oidc.ts';

export type Io = {
  isTTY: boolean;
  out: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  /** Reads a line without echoing it. */
  secret: (prompt: string) => Promise<string>;
};

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) { super(message); this.name = 'CliError'; this.exitCode = exitCode; }
}

const needTty = (io: Io, what: string) => {
  if (!io.isTTY) throw new CliError(`loupe ${what} needs a terminal (stdin and stdout must be a TTY); refusing to run`, 2);
};

// Typed-ahead input that arrived with the previous line is kept for the next prompt.
let leftover = '';

export function ttyIo(): Io {
  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    isTTY,
    out: (l) => { process.stdout.write(`${l}\n`); },
    ask: async (prompt) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question(prompt)).trim(); } finally { rl.close(); } },
    secret: (prompt) => new Promise<string>((resolve, reject) => {
      const stdin = process.stdin;
      process.stdout.write(prompt);
      stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
      let buf = '';
      const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); };
      const onData = (chunk: string) => {
        const chars = [...chunk];
        for (let i = 0; i < chars.length; i++) {
          const ch = chars[i]!;
          if (ch === '\r' || ch === '\n') { leftover = chars.slice(i + 1).join('').replace(/^\n/, ''); done(); resolve(buf); return; }
          if (ch === '\u0003' || ch === '\u0004') { done(); reject(new CliError('cancelled', 130)); return; }
          if (ch === '\u007f' || ch === '\b') buf = [...buf].slice(0, -1).join('');
          else if (ch >= ' ') buf += ch;
        }
      };
      stdin.on('data', onData);
      if (leftover) { const l = leftover; leftover = ''; onData(l); }
    }),
  };
}

const paths = (dir: string) => ({ client: path.join(dir, FILES.client), auth: path.join(dir, FILES.auth), open: path.join(dir, FILES.breakglassOpen) });

/** `loupe google-setup`: the OAuth client ID and secret, read without echo, into google-oauth.json (mode 600). */
export async function googleSetup(io: Io, dir = configDir()) {
  needTty(io, 'google-setup');
  const client_id = (await io.secret('Google OAuth client ID (no echo): ')).trim();
  const client_secret = (await io.secret('Google OAuth client secret (no echo): ')).trim();
  if (!client_id || !client_secret) throw new CliError('both values are required');
  writePrivateJson(paths(dir).client, { client_id, client_secret } satisfies ClientFile);
  io.out(`wrote ${paths(dir).client} (mode 600). Next: loupe google-enroll`);
}

/** `loupe breakglass set`: an argon2id hash of a password of at least 12 characters, into auth.json. */
export async function breakglassSet(io: Io, dir = configDir()) {
  needTty(io, 'breakglass set');
  const a = await io.secret(`break-glass password, at least ${MIN_LENGTH} characters (no echo): `);
  if ([...a].length < MIN_LENGTH) throw new CliError(`too short: at least ${MIN_LENGTH} characters`);
  const b = await io.secret('again (no echo): ');
  if (a !== b) throw new CliError('the two entries differ; nothing written');
  const cur = readPrivateJson<AuthFile>(paths(dir).auth) ?? {};
  writePrivateJson(paths(dir).auth, { ...cur, breakglass: await hashPassword(a) } satisfies AuthFile);
  io.out(`wrote the break-glass hash to ${paths(dir).auth}. The path stays closed until \`loupe breakglass open\`.`);
}

/** `loupe breakglass open`: opens the break-glass path for one hour. A Google login closes it earlier. */
export async function breakglassOpen(io: Io, dir = configDir(), now = Date.now) {
  needTty(io, 'breakglass open');
  const cur = readPrivateJson<AuthFile>(paths(dir).auth);
  if (!cur?.breakglass) throw new CliError('no break-glass password is set: run `loupe breakglass set` first');
  const until = now() + OPEN_MS;
  writePrivateJson(paths(dir).open, { until });
  io.out(`break-glass path open until ${new Date(until).toISOString()}. A Google login closes it.`);
}

export type EnrollOptions = { dir?: string; port?: number; issuer?: string; timeoutMs?: number };

/**
 * `loupe google-enroll`: one browser login, then the `sub` and e-mail are shown and only the `sub` goes to auth.json on `y`.
 * It answers the fixed redirect URI itself, so `loupe serve` must not hold the port meanwhile. A running loupe serve notices the
 * new `sub` and closes every session.
 */
export async function googleEnroll(io: Io, o: EnrollOptions = {}) {
  needTty(io, 'google-enroll');
  const dir = o.dir ?? configDir(), port = o.port ?? 4812, issuer = o.issuer ?? GOOGLE_ISSUER;
  const client = readPrivateJson<ClientFile>(paths(dir).client);
  if (!client?.client_id || !client.client_secret) throw new CliError('no OAuth client: run `loupe google-setup` first');
  // The default origin (design v2 6.3); the listener itself stays on 127.0.0.1.
  const origin = `http://localhost:${port}`;
  const redirectUri = `${origin}/auth/google/callback`;
  const oidc = new Oidc(() => ({ issuer, client }));
  // The e-mail is asked for here only, to show it; the server's login asks for `openid` alone.
  const begin = await oidc.begin({ scope: 'openid email', redirectUri }).catch((e: unknown) => { throw new CliError(`identity provider unreachable (${e instanceof LoginFailure ? e.code : 'error'})`); });

  let server: Server | undefined;
  const claims = await new Promise<{ sub: string; email?: string | undefined }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliError('no login within the time limit')), o.timeoutMs ?? 5 * 60_000);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', origin);
      const deny = check('callback', req.method ?? '', (n) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; }, origin);
      const q = url.searchParams;
      if (url.pathname !== '/auth/google/callback' || deny || q.get('state') !== begin.state) { res.writeHead(404).end(); return; }
      const page = (msg: string) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(msg); };
      if (q.has('error') || !q.get('code')) { page('loupe: login failed. Return to the terminal.\n'); clearTimeout(timer); reject(new CliError('the provider returned an error')); return; }
      oidc.finish({ code: q.get('code')!, state: q.get('state')!, iss: q.get('iss') ?? undefined }, { ...begin, redirectUri }).then((c) => {
        page('loupe: login received. Return to the terminal.\n'); clearTimeout(timer); resolve(c);
      }, (e: unknown) => { page('loupe: login failed. Return to the terminal.\n'); clearTimeout(timer); reject(new CliError(`login refused (${e instanceof LoginFailure ? e.code : 'error'})`)); });
    });
    server.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new CliError(e.code === 'EADDRINUSE' ? `127.0.0.1:${port} is in use. Stop loupe first (systemctl --user stop loupe.socket loupe.service), then run this again.` : `cannot listen on 127.0.0.1:${port}`));
    });
    server.listen(port, '127.0.0.1', () => {
      io.out('Open this address in the browser and sign in with the account that may open loupe:');
      io.out(begin.url);
    });
  }).finally(() => { server?.close(); server?.closeAllConnections(); });

  io.out(`sub:   ${claims.sub}`);
  io.out(`email: ${claims.email ?? '(not given)'}`);
  const cur = readPrivateJson<AuthFile>(paths(dir).auth) ?? {};
  if (cur.sub && cur.sub !== claims.sub) io.out('This replaces the allowed account. Every open loupe session will be closed.');
  const yes = (await io.ask('Allow this account to open loupe? Only the sub is written. [y/N] ')).toLowerCase();
  if (yes !== 'y' && yes !== 'yes') { io.out('nothing written'); return false; }
  writePrivateJson(paths(dir).auth, { ...cur, sub: claims.sub } satisfies AuthFile);
  io.out(`wrote the sub to ${paths(dir).auth} (mode 600)`);
  return true;
}

export async function main(cmd: string, args: string[], io: Io = ttyIo()) {
  try {
    if (cmd === 'google-setup') await googleSetup(io);
    else if (cmd === 'google-enroll') await googleEnroll(io, { port: Number(process.env.LOUPE_PORT ?? 4812), issuer: process.env.LOUPE_OIDC_ISSUER || undefined });
    else if (cmd === 'breakglass' && args[0] === 'set') await breakglassSet(io);
    else if (cmd === 'breakglass' && args[0] === 'open') await breakglassOpen(io);
    else throw new CliError('usage: loupe breakglass set|open', 2);
  } catch (e) {
    if (e instanceof CliError) { process.stderr.write(`${e.message}\n`); process.exit(e.exitCode); }
    throw e;
  }
}
