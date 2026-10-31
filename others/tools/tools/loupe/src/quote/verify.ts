// The viewer's own quote check (design 5). A machine check on screen: it never replaces the KB verdict and is never written back.
// Step 1: the code point range equals `exact`. Step 2: NFC search narrowed by prefix and suffix. Anything else highlights nothing.
import type { Evidence } from '../client/model/index.ts';
import { KbProblem } from '../data/kbFetch.ts';
import { cpIndex } from './codepoints.ts';

export type TextRead = { text: string; start: number; end: number; total_chars: number };
export type ReadText = (start: number, maxChars: number) => Promise<TextRead>;

export type Verdict =
  | { kind: 'match'; start: number; end: number }
  | { kind: 'corrected'; start: number; end: number }
  | { kind: 'not-found' }
  | { kind: 'no-quote' }
  | { kind: 'pointer'; pointer: string }
  | { kind: 'unavailable'; reason: 'missing' | 'removed' };

/** Card wording (design 5 table). `quote_found` from the KB is a different statement and is shown beside this one. */
export const VERDICT_LABEL: Record<Verdict['kind'], string> = {
  match: '원문 일치', corrected: '위치 보정', 'not-found': '인용 찾지 못함', 'no-quote': '인용 없음', pointer: '경로 인용', unavailable: '원문 접근 불가',
};

const CONTEXT = 200;
const MAX_WINDOW = 200_000;

/** Step 1 against a window. Offsets are absolute, so the window start is subtracted. */
export function matchesAtOffset(win: TextRead, ev: Pick<Evidence, 'exact' | 'start' | 'end'>): boolean {
  if (ev.exact == null || ev.start == null || ev.end == null) return false;
  if (ev.start < win.start || ev.end > win.end) return false;
  const ix = cpIndex(win.text);
  return win.text.slice(ix.toUtf16(ev.start - win.start), ix.toUtf16(ev.end - win.start)) === ev.exact;
}

// Maps NFC offsets back to the original text. Display bodies are NFC by contract, so this path only runs for a body that breaks it.
function nfcView(text: string): { nfc: string; toOriginal: (utf16: number) => number } {
  const nfc = text.normalize('NFC');
  if (nfc === text) return { nfc, toOriginal: (n) => n };
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const breaks: [number, number][] = [[0, 0]]; // [nfc offset, original offset]
  let n = 0;
  for (const s of seg.segment(text)) { n += s.segment.normalize('NFC').length; breaks.push([n, s.index + s.segment.length]); }
  return { nfc, toOriginal: (at) => { for (const [a, b] of breaks) if (a >= at) return b; return text.length; } };
}

/** Step 2. Returns code point offsets in `text`, or null when `exact` is absent or several places remain. */
export function locateByNfc(text: string, ev: Pick<Evidence, 'exact' | 'prefix' | 'suffix'>): { start: number; end: number } | null {
  if (!ev.exact) return null;
  const { nfc, toOriginal } = nfcView(text);
  const needle = ev.exact.normalize('NFC');
  const prefix = ev.prefix ? ev.prefix.normalize('NFC') : '';
  const suffix = ev.suffix ? ev.suffix.normalize('NFC') : '';
  const hits: number[] = [];
  for (let i = nfc.indexOf(needle); i !== -1; i = nfc.indexOf(needle, i + 1)) {
    if (prefix && !nfc.slice(0, i).endsWith(prefix)) continue;
    if (suffix && !nfc.startsWith(suffix, i + needle.length)) continue;
    hits.push(i);
    if (hits.length > 1) return null;
  }
  const at = hits[0];
  if (at === undefined) return null;
  const ix = cpIndex(text);
  return { start: ix.toCp(toOriginal(at)), end: ix.toCp(toOriginal(at + needle.length)) };
}

export async function readAllText(read: ReadText): Promise<string> {
  let out = '';
  let start = 0;
  for (;;) {
    const w = await read(start, MAX_WINDOW);
    out += w.text;
    if (w.end >= w.total_chars || w.end <= start) return out;
    start = w.end;
  }
}

export async function verifyEvidence(ev: Evidence, read: ReadText): Promise<Verdict> {
  if (ev.selector_kind === 'jsonpointer') return { kind: 'pointer', pointer: ev.json_pointer ?? '' };
  if (!ev.exact) return { kind: 'no-quote' };
  try {
    // Step 1 needs a real range. Offsets that do not make one (end <= start) would ask for a window of no length, which the KB
    // rejects and which would end the check before step 2. They are skipped instead (design 5 table: step 3 follows only after 1 and 2).
    if (ev.start != null && ev.end != null && ev.end > ev.start) {
      const from = Math.max(0, ev.start - CONTEXT);
      const win = await read(from, Math.min(MAX_WINDOW, ev.end - from + CONTEXT));
      if (matchesAtOffset(win, ev)) return { kind: 'match', start: ev.start, end: ev.end };
    }
    const hit = locateByNfc(await readAllText(read), ev);
    return hit ? { kind: 'corrected', ...hit } : { kind: 'not-found' };
  } catch (e) {
    if (e instanceof KbProblem && e.status === 410) return { kind: 'unavailable', reason: 'removed' };
    // A snapshot we may not see and one that does not exist look the same (C 2.7).
    if (e instanceof KbProblem && e.status === 404) return { kind: 'unavailable', reason: 'missing' };
    throw e;
  }
}

/** Runs tasks with a concurrency limit. "Check all" uses 4 (design 5). */
export async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const item = items[next++]!; await task(item).catch(() => undefined); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
