import { describe, expect, it } from 'vitest';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { SearchParamError, validateNodeSearch, validateSourceSearch } from '../src/routes/search.ts';
import { validateTimeSearch } from '../src/time/parse.ts';

const roundTrip = (s: Record<string, unknown>) => defaultParseSearch(defaultStringifySearch(s));

describe('URLs reproduce the screen (design 1, criterion 2)', () => {
  it('time, filters and the quote survive a round trip through the query string', () => {
    const node = { as_of_valid: '2026-10-28T00:00:00Z', as_of_observed: '2026-10-31T12:00:00Z', status: 'all', include_unverified: true, merged_from: 'e:tool:1mcp-app' };
    const back = roundTrip(node);
    expect(validateTimeSearch(back)).toEqual({ as_of_valid: node.as_of_valid, as_of_observed: node.as_of_observed });
    expect(validateNodeSearch(back)).toEqual({ status: 'all', include_unverified: true, merged_from: 'e:tool:1mcp-app' });
    const src = roundTrip({ claim: 'c-4c2e31e4ac9b', ev: 'ev-4c34c6cf', view: 'rendered' });
    expect(validateSourceSearch(src)).toEqual({ claim: 'c-4c2e31e4ac9b', ev: 'ev-4c34c6cf', view: 'rendered' });
  });
  it('the default view is not written to the URL', () => { expect(validateSourceSearch({ view: 'text' })).toEqual({}); });
  it('an unknown key is dropped, not trusted', () => { expect(validateNodeSearch({ evil: '1' })).toEqual({}); });
});

describe('a bad value is an error, not a silent default', () => {
  it.each([[{ status: 'everything' }], [{ include_unverified: 'yes' }], [{ include_unverified: false }], [{ merged_from: '../../x' }], [{ merged_from: 7 }]])('%j', (s) => { expect(() => validateNodeSearch(s)).toThrow(SearchParamError); });
  it.each([[{ claim: 'a/b' }], [{ ev: 'x?y=1' }], [{ view: 'html' }]])('%j', (s) => { expect(() => validateSourceSearch(s)).toThrow(SearchParamError); });
});
