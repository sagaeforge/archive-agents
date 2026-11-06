// Small helpers shared by the runner and the scenarios. No test framework: a scenario is a plain async function.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
export const ms = (t0) => Math.round(performance.now() - t0);

// Poll until fn() returns something truthy. Returns that value, or null at the deadline.
export async function waitFor(fn, timeoutMs, stepMs = 25) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (performance.now() >= end) return null;
    await sleep(stepMs);
  }
}

// Reject after timeoutMs. The timer never keeps the process alive.
export function withTimeout(promise, timeoutMs, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms`), { timeout: true })), timeoutMs); timer.unref?.(); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const short = (v, n = 90) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, n);
