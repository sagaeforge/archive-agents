// The stamp (src/client/stamp.ts) records the sha256 of the contract files the client was generated from.
// This compares it with the live files, so a changed contract fails instead of passing against a stale client.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** @returns {string[]} problems, empty when the stamp matches the live contract */
export function checkStamp(stamp, { openapi, prose }) {
  const problems = [];
  const one = (what, path, want) => {
    if (!existsSync(path)) { problems.push(`${what} is missing at ${path}`); return; }
    const now = sha(path);
    if (now !== want) problems.push(`${what} changed: stamp ${String(want).slice(0, 12)}, live ${now.slice(0, 12)}`);
  };
  one('openapi.yaml', openapi, stamp.inputSha256);
  one('data-interface-v0.md', prose, stamp.proseSha256);
  return problems;
}
