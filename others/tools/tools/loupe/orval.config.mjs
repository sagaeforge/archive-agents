// Generates src/client from the contract the KB publishes. The path comes from scripts/lib/contract-paths.mjs.
import { openapiPath } from './scripts/lib/contract-paths.mjs';

export default { kb: {
  input: { target: openapiPath },
  output: {
    mode: 'split', target: 'src/client/kb.ts', schemas: 'src/client/model', clean: true,
    client: 'react-query', httpClient: 'fetch', urlEncodeParameters: true,
    override: {
      mutator: { path: 'src/data/kbFetch.ts', name: 'kbFetch' },
      fetch: { includeHttpResponseReturnType: false },
      query: { useQuery: true, version: 5, useInfinite: true, useInfiniteQueryParam: 'cursor' },
    },
  },
} };
