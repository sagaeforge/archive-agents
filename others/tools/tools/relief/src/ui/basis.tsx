// The small mark that replaces a line of source and age. Its shape carries the basis, so colour is not alone; the words are on hover and for a screen reader.
import { BASIS_LABEL, basisNote, type Fact } from '../../server/model/fact.ts';

export function BasisMark({ f, nowMs }: { f: Fact<unknown>; nowMs: number }) {
  const note = basisNote(f, nowMs);
  return <span className={`bm ${f.basis}`} title={note} aria-label={note} data-basis-mark={BASIS_LABEL[f.basis]} role="img" />;
}
