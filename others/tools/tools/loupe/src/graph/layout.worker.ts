// One module worker that calls forceAtlas2.assign directly, not the package supervisor: that one writes every iteration back to the main thread
// and needs `worker-src blob:` (design 6.2). The result crosses once, at the end.
import { coldLayout, placeNew } from './layoutCore.ts';
import type { LayoutInput, LayoutResult, PlaceInput } from './layoutInput.ts';

export type WorkerRequest = { id: number } & ({ kind: 'cold'; input: LayoutInput } | { kind: 'place'; input: PlaceInput });
export type WorkerResponse = { id: number; result: LayoutResult; ms: number } | { id: number; error: string };

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const t0 = performance.now();
  try {
    const result = data.kind === 'cold' ? coldLayout(data.input) : placeNew(data.input);
    const res: WorkerResponse = { id: data.id, result, ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(res, [result.xy.buffer as ArrayBuffer, result.community.buffer as ArrayBuffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) } satisfies WorkerResponse);
  }
};
