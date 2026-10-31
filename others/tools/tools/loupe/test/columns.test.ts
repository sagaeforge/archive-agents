import { describe, expect, it } from 'vitest';
import { decodeColumns } from '../src/data/columns.ts';

describe('column decoder (design 7.3)', () => {
  it('finds values by column name, whatever the order', () => {
    expect(decodeColumns({ columns: ['label', 'id'], rows: [['A', 'x'], ['B', 'y']] }, ['id', 'label'])).toEqual([{ id: 'x', label: 'A' }, { id: 'y', label: 'B' }]);
  });
  it('ignores unknown columns and reports a missing one as undefined', () => {
    expect(decodeColumns({ columns: ['id', 'future_column'], rows: [['x', 1]] }, ['id', 'label'])).toEqual([{ id: 'x', label: undefined }]);
  });
  it('an empty table is empty', () => { expect(decodeColumns({ columns: ['id'], rows: [] }, ['id'])).toEqual([]); });
});
