// The layout cache: IndexedDB in the browser profile, nothing on any server (design 6.2). It is an optimisation, so every failure reads as a miss.
import { isValidLayout, KEEP_LAYOUTS, type CachedLayout } from './layoutPlan.ts';

export type LayoutStore = { list(): Promise<CachedLayout[]>; put(record: CachedLayout): Promise<void> };

const newestFirst = (a: CachedLayout, b: CachedLayout) => b.at - a.at;

/** The records to drop: every bad one, then all but the newest KEEP_LAYOUTS. A redacted id leaves the disk this way too (design 5). */
export const evictions = (records: readonly CachedLayout[]) => {
  const good = records.filter(isValidLayout), bad = records.filter((r) => !isValidLayout(r));
  return [...bad, ...[...good].sort(newestFirst).slice(KEEP_LAYOUTS)].map((r) => r.hash);
};

export function memoryLayoutStore(seed: CachedLayout[] = []): LayoutStore {
  const records = new Map(seed.map((r) => [r.hash, r]));
  return {
    list: async () => [...records.values()],
    put: async (r) => {
      records.set(r.hash, r);
      for (const hash of evictions([...records.values()])) records.delete(hash);
    },
  };
}

const DB = 'loupe-layout', STORE = 'layouts';
const done = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const commit = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'hash' }); };
  return done(req);
}

export function indexedDbLayoutStore(): LayoutStore {
  return {
    list: async () => {
      try {
        const db = await open();
        try { return await done(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<CachedLayout[]>); } finally { db.close(); }
      } catch { return []; }
    },
    put: async (record) => {
      try {
        const db = await open();
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          store.put(record);
          const all = await done(store.getAll() as IDBRequest<CachedLayout[]>);
          for (const hash of evictions(all)) store.delete(hash);
          await commit(tx);
        } finally { db.close(); }
      } catch { /* the next open recomputes */ }
    },
  };
}
