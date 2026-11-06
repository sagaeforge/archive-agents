import { describe, expect, it } from 'vitest';
import { parseKbId, encodeKbId, classifyId } from '../src/ids.ts';
import { parseTimeParam, validateTimeSearch, TimeParamError } from '../src/time/parse.ts';
import { compareSchemaVersion, isSampleVersion } from '../src/data/contractVersion.ts';
import { TIME_AXIS_OPERATIONS } from '../src/time/timeAxes.ts';
import { parseKbUrl } from '../server/upstream.ts';

describe('contract-format ids (C 2.10)', () => {
  it.each(['e:feature:claude-code-hooks', 'e:feature:history', 'c-8k2p4q7m1xab', 'n-3fa9c01b77aa12ef', 'f-01JC8ZQ3T9XYZ', 'r-1a2b3c4d5e6f', 's:kworb-yt-daily-kr', 'src:cc-docs', 't-01JC8ZQ3T9XYZ', 'e:topic:한글-슬러그'])('accepts %s', (id) => {
    expect(parseKbId(id)).toEqual({ ok: true, id });
    expect(decodeURIComponent(encodeKbId(id))).toBe(id);
  });
  it.each([
    ['', 'empty'], ['a/b', 'forbidden-char'], ['e:feature/old-form', 'forbidden-char'], ['a?b', 'forbidden-char'], ['a#b', 'forbidden-char'], ['a b', 'forbidden-char'],
    ['a\u0000b', 'forbidden-char'], ['a\nb', 'forbidden-char'], ['a\\b', 'forbidden-char'], ['..', 'dot-segment'], ['.', 'dot-segment'], ['x'.repeat(513), 'too-long'],
  ])('refuses %j', (id, reason) => { expect(parseKbId(id)).toEqual({ ok: false, reason }); });
  it('the router-decoded forms of the hostile deep links are refused', () => {
    expect(parseKbId(decodeURIComponent('ent_a%3Fas_of_valid%3D2020-01-01T00%3A00%3A00Z%23')).ok).toBe(false);
    expect(parseKbId(decodeURIComponent('..%2F..%2F..%2Fadmin%2Fstatus')).ok).toBe(false);
    expect(parseKbId(decodeURIComponent('n-1%2F..%2F..%2Fnodes%2Fe%3Afeature%3Ab')).ok).toBe(false);
  });
  it('classifies by prefix', () => {
    expect(classifyId('src:cc-docs')).toBe('source'); expect(classifyId('s:x')).toBe('series'); expect(classifyId('e:a:b')).toBe('entity');
    expect(classifyId('c-1')).toBe('claim'); expect(classifyId('zzz')).toBe('unknown');
  });
});

describe('time params (design 4)', () => {
  it('accepts RFC 3339 UTC with Z', () => { expect(parseTimeParam('as_of_valid', '2026-10-31T09:12:03Z')).toBe('2026-10-31T09:12:03Z'); expect(parseTimeParam('as_of_valid', '2026-10-31T09:12:03.250Z')).toBeTruthy(); expect(parseTimeParam('x', undefined)).toBeUndefined(); });
  it.each(['2026-10-31', '2026-10-31T09:12:03+09:00', '2026-02-31T00:00:00Z', 'now', '', '2026-10-31T09:12:03', 42, null])('refuses %j instead of falling back to now', (v) => { expect(() => parseTimeParam('as_of_valid', v)).toThrow(TimeParamError); });
  it('validateTimeSearch keeps both axes and drops absent ones', () => {
    expect(validateTimeSearch({ as_of_observed: '2026-01-01T00:00:00Z' })).toEqual({ as_of_observed: '2026-01-01T00:00:00Z' });
    expect(() => validateTimeSearch({ as_of_valid: 'x' })).toThrow();
  });
});

describe('schema_version policy (design 7.3)', () => {
  it('major differs blocks, minor differs warns, same is ok, prerelease ignored', () => {
    expect(compareSchemaVersion('1.0.0', '0.2.0')).toBe('major-differs');
    expect(compareSchemaVersion('0.3.0', '0.2.0')).toBe('minor-differs');
    expect(compareSchemaVersion('0.2.1', '0.2.0')).toBe('ok');
    expect(compareSchemaVersion('0.2.0-sample', '0.2.0')).toBe('ok');
    expect(compareSchemaVersion('v2', '0.2.0')).toBe('unparsable');
  });
  it('flags sample data', () => { expect(isSampleVersion('0.2.0-sample')).toBe(true); expect(isSampleVersion('0.2.0')).toBe(false); });
});

describe('time axis table', () => {
  it('has the C 2.9 exclusion set as false', () => {
    for (const op of ['listChanges', 'getSnapshot', 'getSnapshotText', 'getSnapshotRaw', 'getMeta', 'getSchema', 'getNodeHistory', 'getExportManifest', 'getExportGraph', 'getOpsFreshness', 'listOpsTickets', 'listOpsRuns', 'getOpsMetrics'] as const)
      expect(TIME_AXIS_OPERATIONS[op]).toBe(false);
    for (const op of ['getOverview', 'listNodes', 'getNode', 'getNodeNeighbors', 'getClaim', 'getEdge', 'search', 'getFacets', 'getCounts', 'getSeries'] as const) expect(TIME_AXIS_OPERATIONS[op]).toBe(true);
  });
});

describe('KB_URL', () => {
  it('parses unix: and http URLs without URL() for the socket', () => {
    expect(parseKbUrl('unix:/run/read.sock')).toEqual({ kind: 'unix', path: '/run/read.sock' });
    expect(parseKbUrl('http://127.0.0.1:4811')).toEqual({ kind: 'tcp', https: false, host: '127.0.0.1', port: 4811 });
    expect(() => parseKbUrl('unix:relative.sock')).toThrow();
    expect(() => parseKbUrl('ftp://x')).toThrow();
  });
});
