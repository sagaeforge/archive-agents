import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { large, today } from '../dev/fixtures/gen.ts';
import { validateSnapshot, type Snapshot } from '../server/model/fact.ts';

const dir = new URL('../fixtures/', import.meta.url);
const text = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const NAMES = ['today.json', 'large.json', 'edge.example.json'];

// RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
const DOC = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
const addresses = (t: string) => t.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];

describe('fixtures', () => {
  it('today and large are the generator output, so a stale file fails here', () => {
    expect(JSON.parse(text('today.json'))).toEqual(JSON.parse(JSON.stringify(today())));
    expect(JSON.parse(text('large.json'))).toEqual(JSON.parse(JSON.stringify(large())));
  });
  it('have the object counts the design names (16 and 299) and pass the shape check', () => {
    const t = JSON.parse(text('today.json')) as Snapshot; const l = JSON.parse(text('large.json')) as Snapshot;
    expect(t.nodes.length).toBe(16); expect(l.nodes.length).toBe(299);
    expect(validateSnapshot(t)).toEqual([]); expect(validateSnapshot(l)).toEqual([]);
  });
  it.each(NAMES)('%s uses documentation addresses only', (f) => {
    for (const a of addresses(text(f))) expect(a, `${f}: ${a}`).toMatch(DOC);
  });
  it.each(NAMES)('%s carries no real host name, secret field or local path', (f) => {
    const t = text(f);
    for (const h of t.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []) {
      if (/^\d+(\.\d+)+$/.test(h)) continue;
      if (/^(edge\.json|\d+\.\d+)/.test(h)) continue;
      expect(h, `${f}: ${h}`).toMatch(/(^|\.)example\.com$|^[\w-]+\.json$/);
    }
    expect(t).not.toMatch(/password|psk|secret|token|\/home\/|\/Users\//i);
  });
  it('edge.example.json keeps the cases that mean different things', () => {
    const e = JSON.parse(text('edge.example.json'));
    expect(e.portForwards).toEqual([]);                                  // declared as none
    expect(e.hosts.find((h: { key: string }) => h.key === 'workstation').bmc).toBe('none');
    expect(e.hosts.find((h: { key: string }) => h.key === 'node-3').bmc).toEqual({ interface: 'unknown' });
  });
  it('every id is unique and every edge ends on an existing entity', () => {
    for (const s of [today(), large()]) {
      const ids = new Set(s.nodes.map((n) => n.id));
      expect(ids.size).toBe(s.nodes.length);
      for (const e of s.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true); }
    }
  });
});
