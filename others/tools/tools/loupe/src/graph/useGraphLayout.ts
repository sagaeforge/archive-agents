// Runs the design 6.2 flow for the screen: the base layout once per publish, local placement for whatever else is displayed. The view is told when
// coordinates exist, never before. No layout runs anywhere but here, so leaving the screen ends it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { readCoreExport, readCoreSha } from '../data/graph.ts';
import { indexedDbLayoutStore } from './layoutCache.ts';
import { placeDisplayed, resolveLayout, seededPositions, type LayoutDeps, type LayoutKind, type Positions, type ResolvedLayout } from './layoutFlow.ts';
import type { LayoutInput, PlaceInput } from './layoutInput.ts';
import { createLayoutWorker, type LayoutWorker } from './layoutWorkerClient.ts';
import { decodeTopology, type GraphData } from './model.ts';
import type { GraphView } from './view.ts';

/** S5: about 1 ms per node for 300 iterations in the worker. Only the progress bar reads this. */
export const coldEstimateMs = (nodes: number) => nodes * 0.95;

export type LayoutState =
  | { phase: 'idle' }
  | { phase: 'cold'; nodes: number; startedAt: number }
  | { phase: 'ready'; kind: LayoutKind; source: ResolvedLayout['source']; placed: number }
  | { phase: 'failed'; message: string };

type Base = { nonce: number; scope: string; promise: Promise<ResolvedLayout>; source?: ResolvedLayout['source']; settled: boolean; abort: () => void };

export function useGraphLayout(view: GraphView | null, data: GraphData | null, scope: string, nonce: number): { state: LayoutState; revision: number } {
  const [state, setState] = useState<LayoutState>({ phase: 'idle' });
  const [revision, setRevision] = useState(0);
  const worker = useRef<LayoutWorker | null>(null);
  // The base load is shared by every run that waits on it, so it outlives any one of them. A newer load or leaving the screen stops it.
  const screen = useRef<AbortController | null>(null);
  const base = useRef<Base | null>(null);
  const known = useRef<Positions | null>(null);
  const seeding = useRef(false);
  /** What a cold start must draw: the data of this moment, not of the run that started the load. */
  const drawSeed = useRef<(() => void) | null>(null);
  const store = useMemo(indexedDbLayoutStore, []);

  useEffect(() => {
    const controller = new AbortController();
    worker.current = createLayoutWorker();
    screen.current = controller;
    base.current = null;
    return () => { controller.abort(); worker.current?.terminate(); worker.current = null; screen.current = null; drawSeed.current = null; };
  }, []);

  useEffect(() => {
    if (!view || !data || !worker.current) return;
    let alive = true;
    // Through the ref: a superseded computation is stopped by replacing the worker, and whoever calls next must get the new one.
    const compute = {
      cold: (input: LayoutInput) => worker.current!.cold(input),
      place: (input: PlaceInput) => worker.current!.place(input),
    };
    drawSeed.current = () => { view.setData(data, seededPositions(data.nodes.map((n) => n.id))); setRevision((r) => r + 1); };
    const run = async () => {
      let b = base.current;
      if (!b || b.nonce !== nonce || (b.source === 'overview' && b.scope !== scope)) {
        // A load still running has lost its place. Stopping the worker also spares the new load the wait for the old result.
        if (b && !b.settled) {
          b.abort();
          worker.current!.terminate();
          worker.current = createLayoutWorker();
        }
        known.current = null;
        seeding.current = false;
        const load = new AbortController();
        const signal = AbortSignal.any([screen.current!.signal, load.signal]);
        const onCold = (nodes: number) => {
          seeding.current = true;
          setState({ phase: 'cold', nodes, startedAt: performance.now() });
          drawSeed.current?.();
        };
        const deps: LayoutDeps = {
          ...compute, store, signal,
          readManifestSha: () => readCoreSha(signal),
          readCore: async () => decodeTopology(await readCoreExport(signal)),
        };
        const next: Base = { nonce, scope, promise: resolveLayout(deps, data, scope, onCold), settled: false, abort: () => { load.abort(); } };
        // A load nobody is left to report still must not stay behind as the answer for the next run.
        next.promise.then((r) => { next.settled = true; next.source = r.source; }, () => { next.settled = true; if (base.current === next) base.current = null; });
        base.current = next; b = next;
      } else if (seeding.current) drawSeed.current?.();
      const resolved = await b.promise;
      if (!alive) return;
      const swap = seeding.current;
      seeding.current = false;
      const from = known.current ?? resolved.positions;
      const placed = await placeDisplayed(compute, data, from);
      if (!alive) return;
      known.current = placed;
      if (swap && view.graph.order === data.nodes.length) view.setPositions(placed); else view.setData(data, placed);
      setState({ phase: 'ready', kind: resolved.kind, source: resolved.source, placed: placed.size - resolved.positions.size });
      setRevision((r) => r + 1);
    };
    run().catch((e: unknown) => {
      if (!alive) return;
      seeding.current = false;
      setState({ phase: 'failed', message: e instanceof Error ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [view, data, scope, nonce, store]);

  return { state, revision };
}
