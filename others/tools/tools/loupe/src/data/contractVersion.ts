// schema_version policy (design 7.3, C 8). The generated client records which contract it was built from.
export type VersionVerdict = 'ok' | 'minor-differs' | 'major-differs' | 'unparsable';

const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);

export function compareSchemaVersion(received: string, generated: string): VersionVerdict {
  const a = parse(received), b = parse(generated);
  if (!a || !b) return 'unparsable';
  if (a[1] !== b[1]) return 'major-differs';
  // 0.x may break between minors, but adding a field is compatible (C 8), so the verdict is a warning, not a block.
  if (a[2] !== b[2]) return 'minor-differs';
  return 'ok';
}
/** Sample data must never be mistaken for the real KB: the app shows a fixed badge. */
export const isSampleVersion = (v: string) => /-sample$/.test(v);
