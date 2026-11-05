// The filter of the workspace home (design v2 2.3), with no React or sigma in it. Filtering only hides what the neighbor queries already returned.
import type { GraphData } from '../model.ts';

export const AXES = ['topic', 'document', 'knowledge', 'memo', 'secret'] as const;
export type Axis = (typeof AXES)[number];
export type Selection = ReadonlySet<Axis>;
export const AXIS_LABEL: Record<Axis, string> = { topic: '주제', document: '문서', knowledge: '지식', memo: '메모', secret: '비밀 객체' };

/** Topic and its spec are the topic axis, Page the document axis, Note the memo axis and a secret object's name the secret axis.
 *  Everything else the KB knows (entities, and the claims that hang on them) is knowledge. */
export function kindOf(type: string): Axis {
  if (type === 'Topic' || type === 'TopicSpec') return 'topic';
  if (type === 'Page') return 'document';
  if (type === 'Note') return 'memo';
  if (type.startsWith('Secret')) return 'secret';
  return 'knowledge';
}

export const ALL: Selection = new Set(AXES);
export const isAll = (s: Selection) => s.size === AXES.length;
export const only = (a: Axis): Selection => new Set([a]);
/** Shift+pick. Taking the last axis away shows everything again: an empty graph is never what a person asked for. */
export function toggle(s: Selection, a: Axis): Selection {
  const next = new Set(s);
  if (next.has(a)) next.delete(a); else next.add(a);
  return next.size === 0 ? ALL : next;
}
const inOrder = (s: Selection) => AXES.filter((a) => s.has(a));
/** The text under the gizmo: the kinds are named, never told apart by colour alone. */
export const summary = (s: Selection) => (isAll(s) ? '전체' : inOrder(s).map((a) => AXIS_LABEL[a]).join(' + '));

export const encodeSelection = (s: Selection) => JSON.stringify(inOrder(s));
export function decodeSelection(raw: string | null): Selection {
  try {
    const v: unknown = JSON.parse(raw ?? '');
    if (!Array.isArray(v) || v.length === 0 || !v.every((a) => AXES.includes(a as Axis))) return ALL;
    return new Set(v as Axis[]);
  } catch { return ALL; }
}

/** Nodes of the chosen axes stay. With the topic axis off, the topics themselves stay as anchors so a cluster does not fall apart, and the
 *  topic's spec goes. An edge is drawn only when both ends are shown. */
export function filterGraph(g: GraphData, s: Selection): { data: GraphData; anchors: string[] } {
  if (isAll(s)) return { data: g, anchors: [] };
  const anchors: string[] = [];
  const nodes = g.nodes.filter((n) => {
    if (s.has(kindOf(n.type))) return true;
    if (n.type === 'Topic') { anchors.push(n.id); return true; }
    return false;
  });
  const shown = new Set(nodes.map((n) => n.id));
  return { data: { nodes, edges: g.edges.filter((e) => shown.has(e.src) && shown.has(e.dst)) }, anchors };
}
