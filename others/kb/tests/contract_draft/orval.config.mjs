// loupe와 같은 Orval 설정. 입력과 출력 경로는 환경 변수로 받는다(orval-check.sh).
import { defineConfig } from 'orval';

export default defineConfig({
  kb: {
    input: { target: process.env.KB_SPEC },
    output: {
      mode: 'split',
      target: `${process.env.KB_GEN}/kb.ts`,
      schemas: `${process.env.KB_GEN}/model`,
      client: 'react-query',
      httpClient: 'fetch',
      urlEncodeParameters: true,
      override: {
        mutator: { path: './kb-fetch.ts', name: 'kbFetch' },
        fetch: { includeHttpResponseReturnType: false },
        query: { useInfinite: true, useInfiniteQueryParam: 'cursor' },
      },
    },
  },
});
