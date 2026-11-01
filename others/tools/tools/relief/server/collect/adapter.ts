// The read-adapter shape (design 19) and the loop around it. An adapter reads; it has no write method. Loop timing lives here, not in the adapters.
export type ReadAdapter<R> = { id: string; periodS(): number; read(signal: AbortSignal): Promise<R> };

export type Loop = { stop(): void; kick(): void };

/** Single-flight by construction: the next run is planned when this one ends, so a slow run skips its turn rather than overlapping (design 6.5). */
export function runLoop<R>(a: ReadAdapter<R>, apply: (r: R) => void): Loop {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  const plan = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void tick(), ms); };
  async function tick() {
    if (running) { again = true; return; }
    running = true;
    const t0 = Date.now();
    try { const r = await a.read(ctl.signal); if (!stopped) apply(r); } catch (e) { if (!stopped) console.error(`relief: ${a.id} loop: ${String((e as Error).name)}`); }
    running = false;
    const left = a.periodS() * 1000 - (Date.now() - t0);
    plan(again ? 0 : Math.max(0, left));
    again = false;
  }
  plan(0);
  return { stop() { stopped = true; clearTimeout(timer); ctl.abort(); }, kick() { plan(0); } };
}
