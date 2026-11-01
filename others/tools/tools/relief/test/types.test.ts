// The type layer (design 12): these lines are checked by `tsc`. The runtime part only keeps the file in the test run.
import { describe, expect, it } from 'vitest';
import type { Basis, Entity, Fact, Snapshot } from '../server/model/fact.ts';

const observed = { value: 3, basis: 'observed', source: 'pve:/cluster/resources', at: '2026-11-01T09:00:00Z', ttlS: 45 } satisfies Fact<number>;
const unknown = { value: null, basis: 'unknown', source: 'pve:/agent', at: null, ttlS: null, why: 'guest agent 응답 없음' } satisfies Fact<string>;
// @ts-expect-error a fact must say where it comes from
const noSource: Fact<number> = { value: 3, basis: 'observed', at: null, ttlS: null };
// @ts-expect-error the four bases are closed
const badBasis: Basis = 'guessed';
// @ts-expect-error an entity cannot leave out its basis
const noBasis: Entity = { id: 'a', kind: 'vm', title: 'a', state: 'running', facts: {} };
// @ts-expect-error a snapshot carries its layout
const noLayout: Snapshot = { schema: 1, seq: 1, takenAt: '', nodes: [], edges: [], sources: [] };

describe('types', () => {
  it('compiles', () => { expect([observed.basis, unknown.basis, noSource, badBasis, noBasis, noLayout].length).toBe(6); });
});
