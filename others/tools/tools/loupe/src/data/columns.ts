// Column responses (overview, neighbors, export). Columns are found by name: their order is not assumed and unknown columns are ignored (design 7.3).
export type ColumnTable = { columns: readonly string[]; rows: readonly (readonly unknown[])[] };

export function decodeColumns<K extends string>(table: ColumnTable, wanted: readonly K[]): Record<K, unknown>[] {
  const at = wanted.map((k) => [k, table.columns.indexOf(k)] as const);
  return table.rows.map((row) => Object.fromEntries(at.map(([k, i]) => [k, i < 0 ? undefined : row[i]])) as Record<K, unknown>);
}
