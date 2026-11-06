// Opt-in M2 read side of the write imitation (design v2 11.3 "M2 문서", 5.3): a record that dev/kb-mock/write.ts accepted can be read by ID, followed through
// its versions (`/history`, and `as_of_observed` for the body of one version) and listed when it is dead (the trash window, ADR-0005 L1011).
// Nothing here changes the write contract: it only looks at the map the write routes keep. Without `write` none of it exists.
//
// A tombstone has no body in ADR-0005 (a 409 `current` carries `{version, status}` only), so what a dead record answers on a direct read is a guess:
// the status `dead`, the tombstone's version, and the last live content, so that a restore (`PUT expected_version=<tombstone>`) has something to send.
// A record the quarantine hid (`hidden`) is a plain 404, like the write routes treat it (ADR-0005 5.1).
import type { Rec, RecordStore, Version } from './write.ts';

type Json = Record<string, unknown>;
const live = (r: Rec, atMs?: number): Version | undefined => {
  if (atMs === undefined) return r.versions[r.versions.length - 1];
  return [...r.versions].reverse().find((v) => Date.parse(v.recordedAt) <= atMs);
};
/** The content a record had when it last was alive: the version a tombstone copies. */
const content = (r: Rec, v: Version) => (v.status === 'dead' ? [...r.versions].reverse().find((x) => x.status === 'active') ?? v : v);

function node(id: string, r: Rec, v: Version): Json {
  const c = content(r, v).record;
  return {
    id, type: r.type, label: String(c.title ?? ''), origin: 'first_party', sensitivity: r.sensitivity, status: v.status, version: v.version,
    recorded_at: v.recordedAt, valid: { from: null, to: null }, domain: [], props: c.props ?? {},
  };
}

export function writtenView(store: RecordStore) {
  const seen = (id: string) => { const r = store.get(id); return r && !r.hidden ? r : undefined; };
  return {
    /** `NodeDetail` of a written record, at `atMs` (a version's `recorded_at`) or now. Null when there is no such record or version. */
    detail(id: string, atMs?: number): Json | null {
      const r = seen(id), v = r && live(r, atMs);
      if (!r || !v) return null;
      return {
        ...node(id, r, v), claims: [], edges: { in: [], out: [], truncated: false }, backlinks: [],
        body: String(content(r, v).record.body ?? ''), body_format: 'markdown',
      };
    },
    /** The `versions` of `/history`: every version, newest last, each ended by the next one's `recorded_at`. */
    history(id: string): Json | null {
      const r = seen(id);
      if (!r) return null;
      return {
        id, chains: [], edges: [],
        versions: r.versions.map((v, i) => ({ version: v.version, label: String(content(r, v).record.title ?? ''), status: v.status, recorded_at: v.recordedAt, expired_at: r.versions[i + 1]?.recordedAt ?? null })),
      };
    },
    /** Written records whose newest version has this status, newest first, filtered by type. */
    list(status: 'active' | 'dead', types: Set<string> | null): Json[] {
      const out: Json[] = [];
      for (const [id, r] of store) {
        const v = live(r);
        if (r.hidden || !v || v.status !== status || (types && !types.has(r.type))) continue;
        out.push(node(id, r, v));
      }
      return out.sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
    },
  };
}
