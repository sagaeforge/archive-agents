import { describe, expect, it } from 'vitest';
import { cpIndex, cpLength, cpSlice, hasAstral, splitHighlights } from '../src/quote/codepoints.ts';
import { locateByNfc, matchesAtOffset, readAllText, runLimited, verifyEvidence, VERDICT_LABEL, type ReadText } from '../src/quote/verify.ts';
import { KbProblem, KbUnavailable } from '../src/data/kbFetch.ts';
import type { Evidence } from '../src/client/model/index.ts';

const ev = (o: Partial<Evidence>): Evidence => ({ id: 'ev-1', snapshot_id: 'n-1', selector_kind: 'text_quote', evidence_state: 'live', ...o });
const reader = (text: string, log: [number, number][] = []): ReadText => async (start, max) => {
  log.push([start, max]);
  const chars = [...text];
  const end = Math.min(chars.length, start + max);
  return { text: chars.slice(start, end).join(''), start, end, total_chars: chars.length };
};

describe('code points and UTF-16', () => {
  it('needs no table without astral characters', () => {
    expect(hasAstral('한글 abc')).toBe(false);
    const ix = cpIndex('한글 abc');
    expect(ix.toUtf16(3)).toBe(3); expect(ix.toCp(3)).toBe(3); expect(ix.length).toBe(6);
  });
  it('maps both ways past an emoji', () => {
    const s = 'a🚀b🔥c';
    expect(cpLength(s)).toBe(5); expect(s.length).toBe(7);
    const ix = cpIndex(s);
    expect([0, 1, 2, 3, 4, 5].map((c) => ix.toUtf16(c))).toEqual([0, 1, 3, 4, 6, 7]);
    expect([0, 1, 3, 4, 6, 7].map((u) => ix.toCp(u))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cpSlice(s, 2, 4)).toBe('b🔥');
  });
  it('agrees with the formula in the contract (C 2.11)', () => {
    const s = '🧪 인용 앞에 🚀 있다 **Q**';
    for (const cp of [0, 1, 2, 5, 9, 12]) expect(cpIndex(s).toUtf16(cp)).toBe([...s].slice(0, cp).join('').length);
  });
  it('clamps out of range offsets', () => {
    expect(cpIndex('ab').toUtf16(9)).toBe(2);
    expect(cpIndex('a🚀').toUtf16(9)).toBe(3);
    expect(cpIndex('a🚀').toUtf16(-1)).toBe(0);
  });
});

describe('search highlights (C 4.8)', () => {
  it('cuts by code point, not by UTF-16 index', () => {
    expect(splitHighlights('🚀 sigma 끝', [{ start: 2, end: 7 }])).toEqual([{ text: '🚀 ', hit: false }, { text: 'sigma', hit: true }, { text: ' 끝', hit: false }]);
  });
  it('ignores bad and overlapping ranges', () => {
    expect(splitHighlights('abc', [{ start: 2, end: 9 }, { start: -1, end: 1 }, { start: 1, end: 1 }])).toEqual([{ text: 'abc', hit: false }]);
    expect(splitHighlights('abcd', [{ start: 0, end: 2 }, { start: 1, end: 3 }])).toEqual([{ text: 'ab', hit: true }, { text: 'cd', hit: false }]);
  });
});

describe('step 1: the code point range equals exact', () => {
  const body = '앞 문장. 🚀 인용할 문장이다. 뒤 문장.';
  const [start, end] = [8, 17];
  const win = { text: body, start: 0, end: [...body].length, total_chars: [...body].length };
  it('matches', () => { expect([...body].slice(start, end).join('')).toBe('인용할 문장이다.'); expect(matchesAtOffset(win, { exact: '인용할 문장이다.', start, end })).toBe(true); });
  it('subtracts the window start: offsets are absolute', () => {
    const w = { text: [...body].slice(5).join(''), start: 5, end: win.end, total_chars: win.total_chars };
    expect(matchesAtOffset(w, { exact: '인용할 문장이다.', start, end })).toBe(true);
  });
  it('refuses a range outside the window and a text that differs', () => {
    expect(matchesAtOffset({ ...win, text: body.slice(0, 3), end: 3 }, { exact: '인용할 문장이다.', start, end })).toBe(false);
    expect(matchesAtOffset(win, { exact: '다른 문장', start, end })).toBe(false);
    expect(matchesAtOffset(win, { exact: '인용할 문장이다.', start: null, end: null })).toBe(false);
  });
  it('is not satisfied by NFD spelling: that is step 2', () => {
    expect(matchesAtOffset(win, { exact: '인용할 문장이다.'.normalize('NFD'), start, end })).toBe(false);
  });
});

describe('step 2: NFC search, narrowed by prefix and suffix', () => {
  it('finds an NFD quote in an NFC body', () => {
    expect(locateByNfc('머리 인용할 문장 꼬리', { exact: '인용할 문장'.normalize('NFD') })).toEqual({ start: 3, end: 9 });
  });
  it('uses prefix and suffix to pick one of several', () => {
    const t = 'x 값 y 값 z';
    expect(locateByNfc(t, { exact: '값', prefix: 'y ' })).toEqual({ start: 6, end: 7 });
    expect(locateByNfc(t, { exact: '값', suffix: ' y' })).toEqual({ start: 2, end: 3 });
  });
  it('several places left means no place at all', () => { expect(locateByNfc('값 값', { exact: '값' })).toBeNull(); });
  it('a prefix that does not fit means no place', () => { expect(locateByNfc('머리 값 꼬리', { exact: '값', prefix: '다른 ' })).toBeNull(); });
  it('reports code points after an emoji', () => { expect(locateByNfc('🚀🔥 값', { exact: '값' })).toEqual({ start: 3, end: 4 }); });
  it('maps back through a body that is not NFC', () => {
    const body = `${'앞'.normalize('NFD')} 값 뒤`;
    expect(body).not.toBe(body.normalize('NFC'));
    const hit = locateByNfc(body, { exact: '값' })!;
    expect(cpSlice(body, hit.start, hit.end)).toBe('값');
    expect(hit.start).toBe(4); // 앞 in NFD is three code points
  });
  it('nothing to find', () => { expect(locateByNfc('abc', { exact: 'zzz' })).toBeNull(); expect(locateByNfc('abc', { exact: null })).toBeNull(); });
});

describe('verifyEvidence', () => {
  const body = `${'가'.repeat(20_000)}찾을 문장${'나'.repeat(25_000)}`;
  const at = 20_000, to = 20_005;
  it('match: reads only a small window around the offset', async () => {
    const log: [number, number][] = [];
    expect(await verifyEvidence(ev({ exact: '찾을 문장', start: at, end: to }), reader(body, log))).toEqual({ kind: 'match', start: at, end: to });
    expect(log).toEqual([[at - 200, 405]]);
  });
  it('shifted offsets: step 2 reads to text_chars and reports the found place', async () => {
    const log: [number, number][] = [];
    expect(await verifyEvidence(ev({ exact: '찾을 문장', start: at + 3, end: to + 3 }), reader(body, log))).toEqual({ kind: 'corrected', start: at, end: to });
    expect(log.length).toBe(2);
  });
  it('a quote across a window boundary still matches: the check reads around it', async () => {
    const q = '경계를 넘는 긴 인용구 문장입니다 끝';
    const t = `${'가'.repeat(19_990)}${q}${'나'.repeat(100)}`;
    const end = 19_990 + q.length;
    expect(end).toBeGreaterThan(20_000);
    expect(await verifyEvidence(ev({ exact: q, start: 19_990, end }), reader(t))).toEqual({ kind: 'match', start: 19_990, end });
  });
  it('no offsets at all goes straight to step 2', async () => {
    expect(await verifyEvidence(ev({ exact: '찾을 문장', start: null, end: null }), reader(body))).toEqual({ kind: 'corrected', start: at, end: to });
  });
  it('not found', async () => { expect(await verifyEvidence(ev({ exact: '없는 문장', start: 1, end: 6 }), reader(body))).toEqual({ kind: 'not-found' }); });
  it('no quote and JSON pointer read no text', async () => {
    const log: [number, number][] = [];
    expect(await verifyEvidence(ev({ exact: null }), reader(body, log))).toEqual({ kind: 'no-quote' });
    expect(await verifyEvidence(ev({ selector_kind: 'jsonpointer', json_pointer: '/a/0' }), reader(body, log))).toEqual({ kind: 'pointer', pointer: '/a/0' });
    expect(log).toEqual([]);
  });
  it('404 and 410 mean the source cannot be reached, nothing more', async () => {
    const fail = (status: number, code: string): ReadText => async () => { throw new KbProblem({ type: 'x', title: code, status, code }); };
    expect(await verifyEvidence(ev({ exact: 'x', start: 0, end: 1 }), fail(404, 'not_found'))).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(await verifyEvidence(ev({ exact: 'x', start: 0, end: 1 }), fail(410, 'content_removed'))).toEqual({ kind: 'unavailable', reason: 'removed' });
  });
  it('a KB outage is an error, not a verdict about the quote', async () => {
    await expect(verifyEvidence(ev({ exact: 'x', start: 0, end: 1 }), async () => { throw new KbUnavailable('network', 'down'); })).rejects.toBeInstanceOf(KbUnavailable);
  });
  it('has wording for every verdict', () => { expect(Object.keys(VERDICT_LABEL).sort()).toEqual(['corrected', 'match', 'no-quote', 'not-found', 'pointer', 'unavailable']); });
});

describe('reading the whole body', () => {
  it('follows windows to total_chars', async () => {
    const log: [number, number][] = [];
    const body = 'ab'.repeat(150_000);
    expect(await readAllText(reader(body, log))).toBe(body);
    expect(log).toEqual([[0, 200_000], [200_000, 200_000]]);
  });
  it('stops on a window that does not advance', async () => { expect(await readAllText(async () => ({ text: '', start: 0, end: 0, total_chars: 5 }))).toBe(''); });
});

describe('runLimited', () => {
  it('never runs more than the limit and finishes everything, even past a failure', async () => {
    let running = 0, peak = 0;
    const done: number[] = [];
    await runLimited([...Array(20).keys()], 4, async (i) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--; done.push(i);
      if (i === 3) throw new Error('one fails');
    });
    expect(peak).toBe(4); expect(done).toHaveLength(20);
  });
});
