import { describe, expect, it } from 'vitest';
import { ALL, decodeSelection, encodeSelection, filterGraph, isAll, kindOf, only, summary, toggle } from '../src/graph/gizmo/model.ts';
import type { GraphData } from '../src/graph/model.ts';

const node = (id: string, type: string) => ({ id, label: id, type, status: 'active' });
const edge = (id: string, src: string, dst: string) => ({ id, src, dst, rtype: 'REL', status: 'active' });
const g: GraphData = {
  nodes: [node('t', 'Topic'), node('s', 'TopicSpec'), node('p', 'Page'), node('n', 'Note'), node('k', 'Tool'), node('x', 'Secret')],
  edges: [edge('e1', 's', 't'), edge('e2', 'p', 't'), edge('e3', 'n', 't'), edge('e4', 'p', 'k'), edge('e5', 'p', 'x')],
};

describe('kinds', () => {
  it('puts every node type on one axis', () => {
    expect(['Topic', 'TopicSpec', 'Page', 'Note', 'Secret', 'Tool', 'Library', 'Claim'].map(kindOf)).toEqual(['topic', 'topic', 'document', 'memo', 'secret', 'knowledge', 'knowledge', 'knowledge']);
  });
});

describe('selection', () => {
  it('shows everything by default and one axis on a plain pick', () => {
    expect(isAll(ALL)).toBe(true);
    expect([...only('document')]).toEqual(['document']);
  });
  it('adds and removes axes, and falls back to everything instead of nothing', () => {
    const docMemo = toggle(only('document'), 'memo');
    expect([...docMemo].sort()).toEqual(['document', 'memo']);
    expect([...toggle(docMemo, 'memo')]).toEqual(['document']);
    expect(isAll(toggle(only('document'), 'document'))).toBe(true);
  });
  it('writes the visible kinds in axis order, never by colour', () => {
    expect(summary(ALL)).toBe('전체');
    expect(summary(toggle(only('memo'), 'document'))).toBe('문서 + 메모');
    expect(summary(toggle(only('knowledge'), 'topic'))).toBe('주제 + 지식');
  });
  it('survives a round trip and rejects anything else in storage', () => {
    expect([...decodeSelection(encodeSelection(toggle(only('secret'), 'memo')))].sort()).toEqual(['memo', 'secret']);
    for (const bad of [null, '', '{', '[]', '["nope"]', '"document"', '[1]']) expect(isAll(decodeSelection(bad))).toBe(true);
  });
});

describe('filterGraph', () => {
  const ids = (d: GraphData) => d.nodes.map((n) => n.id);
  it('is the identity for everything', () => {
    const r = filterGraph(g, ALL);
    expect(ids(r.data)).toEqual(ids(g)); expect(r.data.edges).toHaveLength(5); expect(r.anchors).toEqual([]);
  });
  it('keeps the topic as an anchor when the topic axis is off and drops edges to hidden nodes', () => {
    const r = filterGraph(g, only('document'));
    expect(ids(r.data)).toEqual(['t', 'p']);
    expect(r.anchors).toEqual(['t']);
    expect(r.data.edges.map((e) => e.id)).toEqual(['e2']);
  });
  it('has no anchor while the topic axis is shown, and the spec goes with the topics', () => {
    const r = filterGraph(g, only('topic'));
    expect(ids(r.data)).toEqual(['t', 's']); expect(r.anchors).toEqual([]); expect(r.data.edges.map((e) => e.id)).toEqual(['e1']);
  });
  it('combines kinds', () => {
    expect(ids(filterGraph(g, toggle(only('document'), 'memo')).data)).toEqual(['t', 'p', 'n']);
    expect(ids(filterGraph(g, toggle(only('knowledge'), 'topic')).data)).toEqual(['t', 's', 'k']);
  });
});
