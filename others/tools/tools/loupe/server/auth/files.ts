// The files the login reads (design v2 6.2). They live outside the repository, under ~/.config/loupe by default, mode 600.
// Nothing here prints a value: errors name the file and the problem only.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const configDir = (env: NodeJS.ProcessEnv = process.env) => path.resolve(env.LOUPE_CONFIG_DIR ?? path.join(os.homedir(), '.config/loupe'));

export const FILES = {
  /** Google OAuth client: `{ client_id, client_secret }`. Written by `loupe google-setup` until KMS renders it. */
  client: 'google-oauth.json',
  /** The allowed account and the break-glass hash: `{ sub?, breakglass? }`. Written only by the TTY commands. */
  auth: 'auth.json',
  /** `{ until }` while the break-glass path is open. `loupe breakglass open` writes it; a Google login removes it. */
  breakglassOpen: 'breakglass-open.json',
  /** `{ origins: [...] }`: the origins loupe answers as (owner-corrected 2026-11-04). Absent → only http://localhost:<port>. */
  loupe: 'loupe.json',
} as const;

export type ClientFile = { client_id: string; client_secret: string };
export type AuthFile = { sub?: string; breakglass?: string };
export type OpenFile = { until: number };
export type LoupeFile = { origins?: unknown[] };

export class FileProblem extends Error {
  readonly file: string;
  readonly reason: 'missing' | 'mode' | 'invalid' | 'owner';
  constructor(file: string, reason: 'missing' | 'mode' | 'invalid' | 'owner') { super(`${file}: ${reason}`); this.name = 'FileProblem'; this.file = file; this.reason = reason; }
}

const uid = () => process.getuid?.() ?? -1;

/**
 * The directory must be a real directory (not a symlink) owned by this user and not writable by group or others: anyone who can
 * write there can swap the files under loupe. A missing directory is not a problem for readers.
 */
export function checkDir(dir: string): FileProblem | null {
  let st;
  try { st = lstatSync(dir); } catch { return null; }
  const name = `${path.basename(dir)}/`;
  if (!st.isDirectory()) return new FileProblem(name, 'invalid');
  if (st.uid !== uid()) return new FileProblem(name, 'owner');
  if (st.mode & 0o022) return new FileProblem(name, 'mode');
  return null;
}

/**
 * Reads a JSON file only the owner may read. Missing → null. The file is opened once with O_NOFOLLOW and every check (regular
 * file, owner, mode 600-style) is made on that descriptor, so nothing can be swapped between the check and the read.
 */
export function readPrivateJson<T>(file: string): T | null {
  const dirProblem = checkDir(path.dirname(file));
  if (dirProblem) throw dirProblem;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FileProblem(path.basename(file), 'invalid'); // ELOOP: a symlink
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FileProblem(path.basename(file), 'invalid');
    if (st.uid !== uid()) throw new FileProblem(path.basename(file), 'owner');
    if (st.mode & 0o077) throw new FileProblem(path.basename(file), 'mode');
    try { return JSON.parse(readFileSync(fd, 'utf8')) as T; } catch { throw new FileProblem(path.basename(file), 'invalid'); }
  } finally { closeSync(fd); }
}

/**
 * Writes JSON with mode 600: a new temporary file created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW, random name), synced, then renamed
 * over the target, so a reader never sees half a file and no planted file or symlink is written through.
 */
export function writePrivateJson(file: string, value: unknown, tmpName?: string) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const problem = checkDir(dir);
  if (problem) throw problem;
  // `tmpName` exists for the test that plants a file or a link at the temporary path.
  const tmp = tmpName ? path.join(dir, tmpName) : `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
  closeSync(fd);
  renameSync(tmp, file);
}

export const removeFile = (file: string) => rmSync(file, { force: true });

/** A cached reader that re-reads only when the file changes (mtime, size, inode). */
export function watchedJson<T>(file: string) {
  let key = '', value: T | null = null, problem: FileProblem | null = null;
  return () => {
    // The directory is part of the key: a directory that becomes group-writable must be refused at once.
    let k = 'none';
    try { const d = statSync(path.dirname(file)); k = `${d.mode}:${d.uid}:`; } catch { /* missing */ }
    try { const st = lstatSync(file); k += `${st.mtimeMs}:${st.size}:${st.ino}:${st.mode}:${st.uid}`; } catch { k += 'none'; }
    if (k !== key) {
      key = k;
      try { value = readPrivateJson<T>(file); problem = null; } catch (e) { value = null; problem = e instanceof FileProblem ? e : new FileProblem(path.basename(file), 'invalid'); }
    }
    return { value, problem };
  };
}
