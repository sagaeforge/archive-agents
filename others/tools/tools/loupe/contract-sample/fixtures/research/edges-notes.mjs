// Relations between entities and the first-party notes. Pairs that exist in both directions are generated with `both`.
// [src, rtype, dst, options]. Options: both (also emit dst -> src with `rev`), at, status, claim (key of the claim that backs it).
const E = (src, rtype, dst, o = {}) => ({ src, rtype, dst, ...o });
const out = [];
const add = (...a) => out.push(E(...a));
const pair = (a, ra, b, rb, o = {}) => { add(a, ra, b, o); add(b, rb, a, o); };

// ---- structure
for (const [f, p] of [
  ['e:feature:mcp-server-discover', 'e:spec:mcp-2026-07-28'], ['e:feature:mcp-session-id', 'e:spec:mcp-2025-11-25'], ['e:feature:mcp-http-sse', 'e:spec:mcp-2025-11-25'],
  ['e:feature:resource-link-readback', 'e:spec:mcp-2026-07-28'], ['e:component:sdk-composition', 'e:project:sagae-gateway'], ['e:decision:gateway-front-process', 'e:project:sagae-gateway'],
  ['e:decision:contract-client-generator', 'e:project:sagae-viewer'], ['e:spike:s1-aggregation', 'e:project:sagae-gateway'], ['e:spike:s2-lifecycle', 'e:project:sagae-gateway'],
  ['e:spike:s3-graph', 'e:project:sagae-viewer'], ['e:spike:s4-contract', 'e:project:sagae-viewer'], ['e:spike:s5-scale', 'e:project:sagae-viewer'],
]) pair(f, 'PART_OF', p, 'CONTAINS');

// ---- dependencies
for (const [a, b] of [
  ['e:library:sigma-js', 'e:library:graphology'], ['e:library:mcp-hono', 'e:library:mcp-sdk-server'], ['e:library:mcp-hono', 'e:library:hono'], ['e:library:hono-mcp', 'e:library:hono'],
  ['e:component:sdk-composition', 'e:library:mcp-sdk-server'], ['e:component:sdk-composition', 'e:library:hono'], ['e:tool:orval', 'e:library:typescript'], ['e:library:openapi-typescript', 'e:library:typescript'],
  ['e:library:openapi-fetch', 'e:library:openapi-typescript'], ['e:tool:1mcp-agent', 'e:library:mcp-sdk-server'], ['e:tool:mcp-use', 'e:library:hono'], ['e:tool:schemathesis', 'e:spec:openapi-3-1'],
]) add(a, 'DEPENDS_ON', b);

// ---- what the viewer and the gateway use
for (const t of ['e:library:sigma-js', 'e:library:cmdk', 'e:tool:schemathesis', 'e:tool:prism', 'e:tool:orval', 'e:library:hono']) add('e:project:sagae-viewer', 'USES', t);
for (const t of ['e:library:hono', 'e:library:mcp-sdk-server', 'e:library:mcp-hono', 'e:component:sdk-composition', 'e:tool:mcp-conformance']) add('e:project:sagae-gateway', 'USES', t);
add('e:project:sagae-gateway', 'USES', 'e:feature:mcp-session-id', { status: 'dead' });
pair('e:project:sagae-viewer', 'READS_CONTRACT_OF', 'e:project:sagae-kb', 'SERVES_CONTRACT_TO');

// ---- alternatives, stored in both directions
pair('e:tool:orval', 'ALTERNATIVE_TO', 'e:library:openapi-typescript', 'ALTERNATIVE_TO');
pair('e:tool:mcp-use', 'ALTERNATIVE_TO', 'e:tool:fastmcp-ts', 'ALTERNATIVE_TO');
pair('e:tool:agentgateway', 'ALTERNATIVE_TO', 'e:tool:1mcp', 'ALTERNATIVE_TO');
pair('e:library:hono-mcp', 'ALTERNATIVE_TO', 'e:library:mcp-hono', 'ALTERNATIVE_TO');
pair('e:library:sigma-js', 'ALTERNATIVE_TO', 'e:library:cosmos-gl', 'ALTERNATIVE_TO');
add('e:tool:hey-api', 'ALTERNATIVE_TO', 'e:tool:orval');
// parallel edge: the same two ends with a second relation type
add('e:tool:orval', 'REPLACES', 'e:library:openapi-typescript', { status: 'active' });
add('e:spec:mcp-2026-07-28', 'REPLACES', 'e:spec:mcp-2025-11-25');
add('e:feature:mcp-server-discover', 'REPLACES', 'e:feature:mcp-session-id');
add('e:library:mcp-hono', 'REPLACES', 'e:library:hono-mcp');
add('e:tool:1mcp-agent', 'RENAMED_TO', 'e:tool:1mcp', { at: '2026-10-31T16:20:00Z' });
add('e:tool:1mcp-app', 'RENAMED_TO', 'e:tool:1mcp-agent', { at: '2026-10-31T16:20:00Z' });

// ---- spikes evaluated tools, and the spikes know what they evaluated
for (const [t, s] of [
  ['e:tool:agentgateway', 'e:spike:s1-aggregation'], ['e:tool:1mcp', 'e:spike:s1-aggregation'], ['e:tool:mcp-use', 'e:spike:s1-aggregation'], ['e:tool:fastmcp-ts', 'e:spike:s1-aggregation'],
  ['e:component:sdk-composition', 'e:spike:s1-aggregation'], ['e:library:hono', 'e:spike:s2-lifecycle'], ['e:library:sigma-js', 'e:spike:s3-graph'], ['e:library:graphology', 'e:spike:s3-graph'],
  ['e:tool:orval', 'e:spike:s4-contract'], ['e:tool:hey-api', 'e:spike:s4-contract'], ['e:library:openapi-typescript', 'e:spike:s4-contract'], ['e:tool:schemathesis', 'e:spike:s4-contract'],
  ['e:library:sigma-js', 'e:spike:s5-scale'],
]) pair(t, 'EVALUATED_IN', s, 'EVALUATES');

// ---- the front-process decision changes with the verification (time-varying relation)
add('e:decision:gateway-front-process', 'RECOMMENDS', 'e:tool:agentgateway', { claimKey: 'front-old', closedBy: 'front-new' });
add('e:decision:gateway-front-process', 'RECOMMENDS', 'e:library:hono', { claimKey: 'front-new' });
add('e:decision:gateway-front-process', 'FALLBACK_TO', 'e:tool:1mcp');
add('e:decision:contract-client-generator', 'RECOMMENDS', 'e:library:openapi-typescript', { claimKey: 'ot-adopt', closedBy: 'ot-adopt-reversed' });
add('e:decision:contract-client-generator', 'RECOMMENDS', 'e:tool:orval');

// ---- concepts
for (const t of ['e:project:sagae-kb', 'e:tool:graphiti', 'e:tool:graphiti-lens']) add(t, 'EMBODIES', 'e:concept:bitemporal-model');
add('e:concept:korean-fts', 'NEEDED_BY', 'e:project:sagae-kb');
add('e:concept:korean-fts', 'NEEDED_BY', 'e:project:sagae-viewer');
add('e:tool:graphiti-lens', 'INSPIRES', 'e:project:sagae-viewer');
add('e:tool:gephi-lite', 'EXPORT_TARGET_OF', 'e:project:sagae-viewer');
add('e:tool:datasette', 'SIDECAR_OF', 'e:project:sagae-viewer');
add('e:tool:obsidian', 'PROJECTION_TARGET_OF', 'e:project:sagae-kb');
add('e:tool:rtk', 'COMPANION_OF', 'e:tool:trail');
add('e:tool:trail', 'COMPANION_OF', 'e:tool:rtk');
add('e:library:embedding-atlas', 'CANDIDATE_FOR', 'e:project:sagae-viewer');
add('e:product:claude-code', 'CONSUMES', 'e:spec:mcp-2026-07-28');
add('e:product:claude-code', 'CONSUMES', 'e:project:sagae-gateway');
add('e:tool:mcpproxy-go', 'ALTERNATIVE_TO', 'e:tool:agentgateway');
add('e:tool:fastmcp-py', 'ALTERNATIVE_TO', 'e:tool:fastmcp-ts');
add('e:library:mcp-sdk-server', 'IMPLEMENTS', 'e:spec:mcp-2026-07-28');
add('e:tool:agentgateway', 'IMPLEMENTS', 'e:spec:mcp-2026-07-28');
add('e:tool:agentgateway', 'LACKS', 'e:feature:resource-link-readback');
add('e:tool:1mcp', 'LACKS', 'e:feature:resource-link-readback');
add('e:component:sdk-composition', 'PROVIDES', 'e:feature:resource-link-readback');
add('e:concept:gateway-token-storage', 'PROTECTS', 'e:project:sagae-gateway');
add('e:concept:agentgateway-session-key', 'PROTECTS', 'e:tool:agentgateway');
add('e:tool:agentgateway', 'STORES', 'e:concept:agentgateway-session-key');

export const EDGES = out;

// ---- first-party notes (Markdown pages written by the user or by an agent for the user)
export const NOTES = [
  {
    id: 'f-01JD2K7Q9T4M8A', label: '뷰어 IA 메모', sens: 'internal', author: 'user:sagae', at: '2026-10-31T14:00:00Z',
    body: `# 뷰어 IA 메모

탐색 흐름은 [[e:project:sagae-viewer]]에서 시작한다. 팔레트 → 엔티티 → 관계 → 주장 → 인용 원문 순서로 걷는다.

## 지금 걸리는 것
- 한글 라벨: [[e:library:sigma-js]]는 아틀라스 한 쪽을 넘으면 엉뚱한 음절을 그린다. 겹침 라벨로 간다.
- 내보내기: [[e:tool:gephi-lite]]는 노드 1만 개까지만 받는다.
- 출처는 [원문](https://example.test/notes/ia)을 열기 전에 항상 인용부터 본다.

| 화면 | 상태 |
|---|---|
| 팔레트 | 설계 |
| 시간 띠 | 설계 |
`,
    v2: { at: '2026-10-31T17:20:00Z', add: '\n검증 보고서가 나온 뒤 위험 등급을 "막는 결함"으로 고쳤다. [[e:library:sigma-js]]의 이력을 본다.\n' },
    links: ['e:project:sagae-viewer', 'e:library:sigma-js', 'e:tool:gephi-lite'], backlinksFrom: ['e:library:sigma-js'],
  },
  {
    id: 'f-01JD2K7R3W6B1C', label: '게이트웨이 앞단 결정 메모', sens: 'internal', author: 'agent:session-6f2c', on_behalf_of: 'user:sagae', generated_by: 'claude-sonnet-5-5', at: '2026-10-31T16:40:00Z',
    body: `# 게이트웨이 앞단 결정 메모

검증 결과로 [[e:decision:gateway-front-process]]의 1순위가 바뀌었다.

1. 이전: [[e:tool:agentgateway]] 우선
2. 지금: [[e:library:hono]] 위의 SDK v2 composition 우선

\`\`\`text
agentgateway는 KB 코드를 호스팅하지 못한다
\`\`\`

남은 질문은 URI 충돌 규칙이다. [[e:component:sdk-composition]]은 URI가 겹치면 엉뚱한 상류의 본문을 돌려준다.
`,
    links: ['e:decision:gateway-front-process', 'e:tool:agentgateway', 'e:library:hono', 'e:component:sdk-composition'], backlinksFrom: ['e:decision:gateway-front-process'],
  },
  {
    id: 'f-01JD2K7S8X2D5E', label: '토큰 보관 메모 (비공개)', sens: 'private', author: 'user:sagae', at: '2026-10-31T17:45:00Z',
    body: `# 토큰 보관 메모

표본 데이터다. 실제 값이 아니다.

- 게이트웨이 토큰은 환경 파일에서 읽는다: \`GATEWAY_TOKEN=<sample-not-a-secret>\`
- 관련: [[e:concept:gateway-token-storage]]
`,
    links: ['e:concept:gateway-token-storage'], backlinksFrom: [],
  },
];
