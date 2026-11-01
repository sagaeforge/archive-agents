// Reads one POST to the bench server. A bad body is the sender's problem: it gets a 400 and never reaches the results file or stops the server.

/** @returns {{ok: true, line: string} | {ok: false, reason: string}} */
export function parseBenchResult(body) {
  let r;
  try { r = JSON.parse(body); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'not an object' };
  if (typeof r.error === 'string') return { ok: true, line: `failed: ${r.error}` };
  const fields = [r.env?.renderer, r.init?.firstFrameMs, r.sync?.cpuGpu?.p95, r.passive?.over20, r.hoverEnter?.p95, r.click?.p95, r.sync?.overlay?.p95];
  if (fields.some((v) => v === undefined)) return { ok: false, reason: 'missing result fields' };
  return { ok: true, line: `${r.label} ${r.size}: ${r.env.renderer} [${r.env.profile}] first frame ${r.init.firstFrameMs} ms, cpu+gpu p95 ${r.sync.cpuGpu.p95}, over 20 ms ${r.passive.over20}, hover p95 ${r.hoverEnter.p95}, click p95 ${r.click.p95}, overlay p95 ${r.sync.overlay.p95}` };
}
