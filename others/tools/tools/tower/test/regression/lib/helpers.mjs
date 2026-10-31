import { callTool, isOk, textOf, toolNames } from './mcp.mjs';
import { waitFor } from './util.mjs';

// Poll tools/list on a fresh modern session until it has at least `want` tools.
export async function fullList(g, want, timeoutMs = 10000, era = 'modern') {
  let last = [];
  const ok = await waitFor(async () => {
    const s = await g.open(era, 5000);
    const r = await s.call('tools/list', {}, 5000);
    last = toolNames(r) ?? [];
    return last.length >= want ? last : null;
  }, timeoutMs, 100);
  return ok ?? last;
}

export const listTools = async (g, era = 'modern', timeoutMs = 20000) => { const s = await g.open(era, timeoutMs); return { s, r: await s.call('tools/list', {}, timeoutMs) }; };
export const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export const jsonText = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
export { callTool, isOk, textOf, toolNames };
export const ALPHA_BETA_TOOLS = ['alpha_status', 'alpha_link_doc', 'beta_status', 'beta_beta_echo'];
