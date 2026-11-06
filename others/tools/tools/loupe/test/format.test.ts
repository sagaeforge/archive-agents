import { describe, expect, it } from 'vitest';
import { formatKst, formatValid, formatValidAxis, isoFromDateInput, isoFromKstInput, kstInputFromIso, parseDateQuery } from '../src/time/format.ts';

describe('time display (design 4)', () => {
  it('shows UTC instants in KST', () => {
    expect(formatKst('2026-10-31T23:00:00Z')).toBe('2026-11-01 08:00 KST');
    expect(formatKst('2026-10-31T23:00:05Z', { seconds: true })).toBe('2026-11-01 08:00:05 KST');
  });
  it('leaves an unparsable value as it came', () => { expect(formatKst('not a time')).toBe('not a time'); });
  it('midnight UTC on the valid axis is a date, and does not move', () => {
    expect(formatValidAxis('2026-10-28T00:00:00Z')).toBe('2026-10-28');
    expect(formatValidAxis('2026-10-28T15:00:00Z')).toBe('2026-10-29 00:00 KST');
  });
});

describe('valid time (C 2.2)', () => {
  it.each([
    [{ from: '2026-07-01', to: null, precision: 'quarter', label: '2026-Q3' }, '2026-Q3'],
    [{ from: '2026-07-01', to: null, precision: 'quarter', label: null }, '2026-Q3부터'],
    [{ from: '2026-10-27', to: null, precision: 'day', label: null }, '2026-10-27부터'],
    [{ from: '2026-10-01', to: null, precision: 'month', label: null }, '2026-10부터'],
    [{ from: '2026-01-01', to: '2026-12-31', precision: 'year', label: null }, '2026'],
    [{ from: '2026-10-27', to: '2026-10-29', precision: 'day', label: null }, '2026-10-27 ~ 2026-10-29'],
    [{ from: null, to: '2026-08-02', precision: 'day', label: null }, '2026-08-02까지'],
    [{ from: '2026-10-31T01:02:03Z', to: null, precision: 'instant', label: null }, '2026-10-31 10:02 KST부터'],
    [{ from: null, to: null, precision: null, label: null }, ''],
  ] as const)('%j', (v, want) => { expect(formatValid(v)).toBe(want); });
  it('a date does not cross a zone', () => { expect(formatValid({ from: '2026-10-27', to: null, precision: 'day', label: null })).toContain('2026-10-27'); });
  it('nothing given', () => { expect(formatValid(undefined)).toBe(''); });
});

describe('inputs', () => {
  it('a date input is midnight UTC with no zone shift', () => { expect(isoFromDateInput('2026-10-28')).toBe('2026-10-28T00:00:00Z'); });
  it('refuses a date that does not exist', () => { expect(isoFromDateInput('2026-02-31')).toBeNull(); expect(isoFromDateInput('nope')).toBeNull(); });
  it('an observed input is KST and round-trips', () => {
    expect(isoFromKstInput('2026-10-31T21:00')).toBe('2026-10-31T12:00:00Z');
    expect(isoFromKstInput('2026-11-01 01:00:30')).toBe('2026-10-31T16:00:30Z');
    expect(kstInputFromIso('2026-10-31T12:00:00Z')).toBe('2026-10-31T21:00:00');
    expect(isoFromKstInput(kstInputFromIso('2026-10-31T16:00:30Z'))).toBe('2026-10-31T16:00:30Z');
  });
  it('the palette reads a date on both axes and a time on the observed axis only', () => {
    expect(parseDateQuery('2026-10-28')).toEqual({ display: '2026-10-28', valid: '2026-10-28T00:00:00Z', observed: '2026-10-27T15:00:00Z' });
    expect(parseDateQuery('2026-10-28 09:30')).toEqual({ display: '2026-10-28 09:30 KST', valid: null, observed: '2026-10-28T00:30:00Z' });
    expect(parseDateQuery('sigma')).toBeNull(); expect(parseDateQuery('2026-13-01')).toBeNull();
  });
});
