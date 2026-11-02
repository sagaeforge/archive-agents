// `relief forget <id>` (design 9.14): takes an object out of what relief remembers. state.json belongs to the service, so the CLI never writes it: two writers would lose one.
// The CLI drops a request into a private directory, atomically, and the service takes it from there on its next tick or at its next start, so nothing is lost if it is down.
// No HTTP route is involved: the surface stays GET only.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const DIR = 'forget';
const MAX_BYTES = 1024;
const MAX_PER_TICK = 16;
const REPLY_KEEP_MS = 3600_000;
const NAME = /^[0-9a-f-]{36}\.req$/;

/** Only what relief remembers can be named: a node or a guest, by the id the map uses. */
export const isForgettable = (id: string) => /^pve:(node:[\w.-]{1,64}|(qemu|lxc):[1-9]\d{0,14})$/.test(id);

export type Reply = { result: 'removed'; kind: string; title: string } | { result: 'unknown' } | { result: 'present' };
const Request = z.strictObject({ id: z.string().max(80) });

const dirOf = (stateDir: string) => join(stateDir, DIR);

export function writeRequest(stateDir: string, id: string): string {
  const dir = dirOf(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomUUID();
  const tmp = join(dir, `${key}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id }), { mode: 0o600 });
  renameSync(tmp, join(dir, `${key}.req`)); // Whole or not at all: the service never sees half a request.
  return key;
}

/** A regular file of a bounded size, or nothing. It is the same user's directory, and still input. */
function readBounded(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n > MAX_BYTES ? null : buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { closeSync(fd); }
}

/** Takes the waiting requests, oldest first by name order, and answers each. A bad one is removed with no answer: nobody valid wrote it. */
export function consumeRequests(stateDir: string, apply: (id: string) => Reply, nowMs: number): number {
  const dir = dirOf(stateDir);
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let done = 0;
  for (const name of names.filter((n) => NAME.test(n)).slice(0, MAX_PER_TICK)) {
    const path = join(dir, name);
    const text = readBounded(path);
    rmSync(path, { force: true });
    let id: string | null = null;
    try { const r = Request.safeParse(JSON.parse(text ?? '')); if (r.success && isForgettable(r.data.id)) id = r.data.id; } catch { /* not a request */ }
    if (id === null) continue;
    const reply = name.replace(/\.req$/, '.done');
    writeFileSync(join(dir, reply), JSON.stringify(apply(id)), { mode: 0o600 });
    done += 1;
  }
  for (const n of names) if (n.endsWith('.done')) { try { if (nowMs - statSync(join(dir, n)).mtimeMs > REPLY_KEEP_MS) rmSync(join(dir, n), { force: true }); } catch { /* it went by itself */ } }
  return done;
}

/** The answer to one request, once it is there. It is removed as it is read. */
export function takeReply(stateDir: string, key: string): Reply | null {
  const path = join(dirOf(stateDir), `${key}.done`);
  try { const r = JSON.parse(readFileSync(path, 'utf8')) as Reply; rmSync(path, { force: true }); return r; } catch { return null; }
}
