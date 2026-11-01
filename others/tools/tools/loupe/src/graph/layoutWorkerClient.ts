// The main-thread side of layout.worker.ts. One worker per screen: leaving the screen ends the computation (design 6.2: no background layout).
import type { LayoutInput, LayoutResult, PlaceInput } from './layoutInput.ts';
import type { WorkerRequest, WorkerResponse } from './layout.worker.ts';

export type LayoutWorker = { cold(input: LayoutInput): Promise<LayoutResult>; place(input: PlaceInput): Promise<LayoutResult>; terminate(): void };

export function createLayoutWorker(): LayoutWorker {
  const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'layout' });
  const pending = new Map<number, { resolve: (r: LayoutResult) => void; reject: (e: Error) => void }>();
  let next = 1;
  const failAll = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); };
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if ('error' in data) p.reject(new Error(data.error)); else p.resolve(data.result);
  };
  worker.onerror = (e) => { failAll(new Error(e.message || 'layout worker failed')); };
  const call = (msg: Omit<Extract<WorkerRequest, { kind: 'cold' }>, 'id'> | Omit<Extract<WorkerRequest, { kind: 'place' }>, 'id'>) => new Promise<LayoutResult>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
  return {
    cold: (input) => call({ kind: 'cold', input }),
    place: (input) => call({ kind: 'place', input }),
    terminate: () => { worker.terminate(); failAll(new Error('layout cancelled')); },
  };
}
