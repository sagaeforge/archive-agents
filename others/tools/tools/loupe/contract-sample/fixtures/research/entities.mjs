// Entities of the Phase 1 research fixture: tools, libraries, specs and spikes that docs/research talks about.
// One row per entity. `v2` adds a later version (merge, death). recorded_at is computed by the builder from the first claim.
const E = (id, label, type, domain, props = {}, extra = {}) => ({ id, label, type, domain, props, ...extra });

export const ENTITIES = [
  // ---- products, projects
  E('e:product:claude-code', 'Claude Code', 'Product', 'tooling', { vendor: 'anthropic' }),
  E('e:project:sagae-viewer', 'sagae-tools 뷰어 (loupe)', 'Project', 'viewer', { phase: 'design' }),
  E('e:project:sagae-kb', 'sagae-knowloge-base', 'Project', 'kb', { phase: 'pre-design' }, { sens: 'internal' }),
  E('e:project:sagae-gateway', 'sagae-tools 게이트웨이', 'Project', 'gateway', { phase: 'design' }),
  E('e:component:sdk-composition', 'SDK v2 composition gateway', 'Component', 'gateway', { lines: '207' }),
  E('e:decision:gateway-front-process', '게이트웨이 앞단 프로세스 결정', 'Decision', 'gateway', {}),
  E('e:decision:contract-client-generator', '계약 클라이언트 생성기 결정', 'Decision', 'viewer', {}),

  // ---- specs and features
  E('e:spec:mcp-2026-07-28', 'MCP 2026-07-28', 'Spec', 'gateway', { kind: 'protocol revision' }, { valid: ['2026-07-28', null] }),
  E('e:spec:mcp-2025-11-25', 'MCP 2025-11-25', 'Spec', 'gateway', { kind: 'protocol revision' }, { liveness: 'superseded' }),
  E('e:spec:openapi-3-1', 'OpenAPI 3.1', 'Spec', 'viewer', { kind: 'api description' }),
  // dead: the session id was removed by the 2026-07-28 revision. v2 records the death after the gateway report.
  E('e:feature:mcp-session-id', 'Mcp-Session-Id', 'Feature', 'gateway', { spec: 'mcp' }, { v2: { at: '2026-10-31T12:23:00Z', patch: { status: 'dead', liveness: 'removed', valid: [null, '2026-07-28'] } } }),
  E('e:feature:mcp-http-sse', 'HTTP+SSE transport', 'Feature', 'gateway', { spec: 'mcp' }, { liveness: 'deprecated' }),
  E('e:feature:mcp-server-discover', 'server/discover', 'Feature', 'gateway', { spec: 'mcp' }, { valid: ['2026-07-28', null] }),
  E('e:feature:resource-link-readback', 'resource_link 읽기 되돌림', 'Feature', 'gateway', { spec: 'mcp' }),

  // ---- tools
  E('e:tool:agentgateway', 'agentgateway', 'Tool', 'gateway', { license: 'Apache-2.0', verdict: 'partial' }),
  // merge chain: 1mcp-app -> 1mcp-agent -> 1mcp. The final target carries the claims of all three.
  E('e:tool:1mcp', '1MCP', 'Tool', 'gateway', { license: 'Apache-2.0', verdict: 'partial' }),
  E('e:tool:1mcp-agent', '1MCP agent', 'Tool', 'gateway', { repo: '1mcp-app/agent' }, { v2: { at: '2026-10-31T16:20:00Z', patch: { status: 'superseded', liveness: 'renamed', merged_into: 'e:tool:1mcp', merged_into_final: 'e:tool:1mcp' } } }),
  E('e:tool:1mcp-app', '1mcp-app', 'Tool', 'gateway', { repo: '1mcp-app' }, { v2: { at: '2026-10-31T16:20:00Z', patch: { status: 'superseded', liveness: 'renamed', merged_into: 'e:tool:1mcp-agent', merged_into_final: 'e:tool:1mcp' } } }),
  E('e:tool:mcpproxy-go', 'mcpproxy-go', 'Tool', 'gateway', { verdict: 'reject' }),
  E('e:tool:mcp-use', 'mcp-use', 'Tool', 'gateway', { license: 'MIT', verdict: 'fail' }),
  E('e:tool:fastmcp-ts', 'fastmcp-ts', 'Tool', 'gateway', { license: 'Apache-2.0', verdict: 'fail' }),
  E('e:tool:fastmcp-py', 'FastMCP (Python)', 'Tool', 'gateway', { license: 'Apache-2.0' }),
  E('e:tool:datasette', 'Datasette', 'Tool', 'viewer', { license: 'Apache-2.0', verdict: 'adopt' }),
  E('e:tool:gephi-lite', 'Gephi Lite', 'Tool', 'viewer', { license: 'GPL-3.0', verdict: 'adopt' }),
  E('e:tool:prism', 'Prism', 'Tool', 'viewer', { verdict: 'adopt' }),
  E('e:tool:schemathesis', 'Schemathesis', 'Tool', 'viewer', { verdict: 'adopt' }),
  E('e:tool:orval', 'Orval', 'Tool', 'viewer', { license: 'MIT', verdict: 'hold' }),
  E('e:tool:hey-api', 'Hey API', 'Tool', 'viewer', { verdict: 'reject' }),
  E('e:tool:graphiti', 'Graphiti', 'Tool', 'kb', { license: 'Apache-2.0', verdict: 'borrow' }),
  E('e:tool:graphiti-lens', 'graphiti-lens', 'Tool', 'viewer', { license: 'Apache-2.0', verdict: 'borrow' }),
  E('e:tool:obsidian', 'Obsidian', 'Tool', 'viewer', { verdict: 'adapt' }),
  E('e:tool:mcp-conformance', 'MCP conformance', 'Tool', 'gateway', {}),
  E('e:tool:rtk', 'rtk', 'Tool', 'tooling', {}),
  E('e:tool:trail', 'Trail-Code (trail)', 'Tool', 'tooling', {}),

  // ---- libraries
  E('e:library:sigma-js', 'sigma.js', 'Library', 'viewer', { license: 'MIT' }),
  E('e:library:graphology', 'graphology', 'Library', 'viewer', {}),
  E('e:library:cosmos-gl', 'cosmos.gl', 'Library', 'viewer', { verdict: 'reject' }),
  E('e:library:embedding-atlas', 'Embedding Atlas', 'Library', 'viewer', {}),
  E('e:library:hono', 'Hono', 'Library', 'gateway', { license: 'MIT' }),
  E('e:library:mcp-sdk-server', '@modelcontextprotocol/server', 'Library', 'gateway', { license: 'Apache-2.0', verdict: 'adopt' }),
  E('e:library:mcp-hono', '@modelcontextprotocol/hono', 'Library', 'gateway', { license: 'Apache-2.0', verdict: 'adopt' }),
  E('e:library:hono-mcp', '@hono/mcp', 'Library', 'gateway', { license: 'MIT', verdict: 'reject' }),
  E('e:library:openapi-typescript', 'openapi-typescript', 'Library', 'viewer', { license: 'MIT', verdict: 'adopt' }),
  E('e:library:openapi-fetch', 'openapi-fetch', 'Library', 'viewer', { license: 'MIT', verdict: 'adopt' }),
  E('e:library:typescript', 'TypeScript', 'Library', 'viewer', {}),
  E('e:library:cmdk', 'cmdk', 'Library', 'viewer', { license: 'MIT' }),

  // ---- spikes and concepts
  E('e:spike:s1-aggregation', 'S1 MCP 집계 스파이크', 'Spike', 'spike', {}),
  E('e:spike:s2-lifecycle', 'S2 수명주기 스파이크', 'Spike', 'spike', {}),
  E('e:spike:s3-graph', 'S3 그래프 스파이크', 'Spike', 'spike', {}),
  E('e:spike:s4-contract', 'S4 계약 흐름 스파이크', 'Spike', 'spike', {}),
  E('e:spike:s5-scale', 'S5 규모 스파이크', 'Spike', 'spike', {}),
  E('e:concept:bitemporal-model', '이중 시간 모델', 'Concept', 'kb', {}),
  E('e:concept:korean-fts', '한국어 전문검색', 'Concept', 'kb', {}),

  // ---- hidden by sensitivity (private is hidden from every default read, secret is never served over HTTP)
  E('e:concept:gateway-token-storage', '게이트웨이 토큰 보관 방식', 'Concept', 'gateway', {}, { sens: 'private' }),
  E('e:concept:agentgateway-session-key', 'agentgateway 세션 키', 'Concept', 'gateway', {}, { sens: 'secret' }),
];
