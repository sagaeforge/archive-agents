// No-fake rule (design 1 criterion 3, 12): an entity may only claim a source that is configured and readable.
import type { Snapshot } from './fact.ts';

/** Which source status backs which `source` prefix. Rules are backed by the entities they read, checked below. */
const BACKING: [RegExp, string][] = [
  [/^pve:/, 'pve'],
  [/^edge\.json/, 'edge'],
  [/^docker:/, 'docker'],
];

/** @returns problems; empty means no entity stands on a missing source. */
export function checkNoFake(s: Snapshot): string[] {
  const bad: string[] = [];
  const state = new Map(s.sources.map((x) => [x.id, x.state]));
  const ids = new Set(s.nodes.map((n) => n.id));
  for (const n of s.nodes) {
    for (const [k, f] of Object.entries(n.facts)) {
      if (f.basis === 'unknown') continue; // an honest blank needs no source
      const hit = BACKING.find(([re]) => re.test(f.source));
      if (hit) {
        const st = state.get(hit[1]);
        if (st !== 'ok' && st !== 'failing') bad.push(`${n.id}.${k}: source ${hit[1]} is ${st ?? 'absent'}`);
      } else if (f.source.startsWith('rule:')) {
        // A derived entity needs the observations the rule reads. Today both rules read nodes.
        if (!s.nodes.some((m) => m.kind === 'node' && m.basis === 'observed')) bad.push(`${n.id}.${k}: rule without input`);
      } else bad.push(`${n.id}.${k}: unknown source ${f.source}`);
    }
    if (n.basis === 'observed' && !Object.values(n.facts).some((f) => f.basis === 'observed')) bad.push(`${n.id}: observed without an observed fact`);
    if (n.parent && !ids.has(n.parent)) bad.push(`${n.id}: orphan`);
  }
  // A source with status none cannot have entities of its layer.
  if (state.get('docker') !== 'ok' && s.nodes.some((n) => n.kind === 'container')) bad.push('container without docker source');
  if (state.get('pve') === 'none' && s.nodes.some((n) => ['node', 'vm', 'lxc', 'bridge', 'storage'].includes(n.kind))) bad.push('pve entity without pve source');
  if (state.get('edge') !== 'ok' && s.nodes.some((n) => n.basis === 'declared')) bad.push('declared entity without edge source');
  return bad;
}
