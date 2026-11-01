// A Live wired to dev/mcp-mock in a temporary state directory. Everything is synthetic: the token below is a marker the secret test hunts for.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, type Mock } from '../../dev/mcp-mock/mock.ts';
import { createReader, type Reader } from '../../server/collect/mcp.ts';
import { readToken } from '../../server/config.ts';
import { Live, type LiveOptions } from '../../server/live.ts';
import type { Entity, Snapshot } from '../../server/model/fact.ts';

export const TOKEN = 'MARKERTOKEN0123456789abcdefghijklmnopqrstuvwxyz';

export type Rig = {
  dir: string; tokenFile: string; stateDir: string; mock: Mock; reader: Reader; live: Live;
  snap(): Snapshot; entity(id: string): Entity | undefined; file(name: string): string;
  reopen(o?: Partial<LiveOptions>): Live; done(): Promise<void>;
};

const rigs: Rig[] = [];
export async function rig(o: { deadlineMs?: number; now?: () => number; url?: string } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'relief-test-'));
  const tokenFile = join(dir, 'token');
  const stateDir = join(dir, 'state');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const mock = await startMock({ port: 0, token: TOKEN });
  const reader = createReader({ url: o.url ?? mock.url, token: () => readToken(tokenFile), ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}) });
  mkdirSync(stateDir, { recursive: true });
  const r: Rig = {
    dir, tokenFile, stateDir, mock, reader,
    live: new Live({ reader, stateDir, ...(o.now ? { now: o.now } : {}) }),
    snap() { return r.live.view().snapshot; },
    entity(id) { return r.snap().nodes.find((n) => n.id === id); },
    file(name) { try { return readFileSync(join(stateDir, name), 'utf8'); } catch { return ''; } },
    reopen(x = {}) { r.live = new Live({ reader, stateDir, ...(o.now ? { now: o.now } : {}), ...x }); return r.live; },
    async done() { await r.live.stop(); await reader.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  rigs.push(r);
  return r;
}
export async function closeRigs() { for (const r of rigs.splice(0)) await r.done(); }
