// Claims read out of the research reports (before verification). Each quote is a verbatim substring of the snapshot body;
// the builder locates it and the checker re-verifies it. Statements are Korean paraphrases. Nothing here is an opinion of the fixture author.
// C(subject, predicate, value, unit, kind, snapshot, quote, statement, extra)
//   extra: key, sup (key of the claim that supersedes this one), from/to (valid time), stance, speaker, cg (conflict group), ver, miss (quote that cannot be located)
export const C = (s, p, v, u, k, snap, q, t, x = {}) => ({ s, p, v, u, k, snap, q, t, ...x });

export const REPORT_CLAIMS = [
  // ---- ui-blocks.md (UB)
  C('e:library:sigma-js', 'latest_version', '4.0.4', 'version', 'state', 'UB', 'sigma + graphology + @react-sigma/core | 4.0.4 (2026-10-27)', 'sigma.js 최신판은 4.0.4(2026-10-27)이다.', { from: '2026-10-27' }),
  C('e:library:graphology', 'latest_version', '0.26.0', 'version', 'state', 'UB', '0.26.0 (2025-01-26)', 'graphology 최신판은 0.26.0(2025-01-26)이다.', { from: '2025-01-26' }),
  // retroactive correction R1: the capacity of one atlas page. ui-blocks computed 576, verify-viewer corrected it for the device pixel ratio.
  C('e:library:sigma-js', 'atlas_glyphs_per_page', '576', 'glyph', 'state', 'UB', 'My arithmetic gives about 24 × 24 ≈ 576 full-width glyphs per page', 'sigma 4 라벨 아틀라스 한 쪽에는 전각 글리프가 약 576개 들어간다.', { key: 'sigma-cap-old', sup: 'sigma-cap-new', from: '2026-10-27' }),
  // retroactive correction R1b: how serious the Hangul label problem is.
  C('e:library:sigma-js', 'risk_level', 'real risk', 'level', 'state', 'UB', 'Hangul labels are a real risk in sigma 4.', '한글 라벨은 sigma 4에서 실제 위험이다. 실행해 본 것은 아니다.', { key: 'sigma-risk-old', sup: 'sigma-risk-new', from: '2026-10-27' }),
  C('e:library:sigma-js', 'fallback', 'DOM label overlay', null, 'howto', 'UB', 'Fallback if it fails: disable sigma labels and draw the top-N labels as a DOM overlay.', '실패하면 sigma 라벨을 끄고 상위 N개 라벨을 DOM 겹침으로 그린다.'),
  // the claim whose quote cannot be located: an invented paraphrase that the report does not contain
  C('e:library:sigma-js', 'atlas_glyphs_per_page', '512', 'glyph', 'state', 'UB', null, 'sigma 4 라벨 아틀라스는 쪽당 최대 512글리프를 담는다.', { key: 'sigma-cap-512', ver: 'needs_review', miss: 'The atlas holds at most 512 glyphs per page.' }),
  C('e:library:hono', 'latest_version', '4.13.14', 'version', 'state', 'UB', 'hono 4.13.14 (2026-10-25)', 'Hono 최신판은 4.13.14(2026-10-25)이다.', { from: '2026-10-25' }),
  C('e:tool:prism', 'latest_version', '5.16.0', 'version', 'state', 'UB', 'prism-cli 5.16.0 (2026-07-17)', 'Prism 최신판은 5.16.0(2026-07-17)이다.', { from: '2026-07-17' }),
  C('e:tool:prism', 'verdict', 'adopt (day 0 only)', null, 'state', 'UB', '| Prism | 5.16.0, 2026-07-17 | Adopt, day 0 only |', 'Prism은 첫날 한정으로 채택한다.'),
  C('e:tool:schemathesis', 'latest_version', '4.32.7', 'version', 'state', 'UB', '4.32.7 (2026-10-27)', 'Schemathesis 최신판은 4.32.7(2026-10-27)이다.', { from: '2026-10-27' }),
  C('e:library:openapi-typescript', 'latest_version', '7.13.0', 'version', 'state', 'UB', '7.13.0, 0.17.0, 2026-02-11', 'openapi-typescript 최신판은 7.13.0이고 openapi-fetch는 0.17.0이다.', { from: '2026-02-11' }),
  C('e:library:openapi-typescript', 'verdict', 'adopt', null, 'state', 'UB', '| openapi-typescript + openapi-fetch | 7.13.0, 0.17.0, 2026-02-11 | **Adopt** |', '계약 클라이언트 생성기로 openapi-typescript와 openapi-fetch를 채택한다.', { key: 'ot-adopt', sup: 'ot-adopt-reversed', from: '2026-02-11' }),
  // retroactive correction R2: "low risk" stayed true only until verify-gateway found the maintenance-mode announcement dated 2026-09-19.
  C('e:library:openapi-typescript', 'maintenance_risk', 'low', 'level', 'state', 'UB', 'It stays low-risk because the output is plain types and `openapi-fetch` is thin', '유지보수 위험은 낮다. 출력이 평범한 타입이고 openapi-fetch가 얇기 때문이다.', { key: 'ot-risk-old', sup: 'ot-risk-new', from: '2026-09-19' }),
  C('e:tool:orval', 'latest_version', '8.46.0', 'version', 'state', 'UB', '| Orval | 8.46.0, 2026-10-30 | Hold |', 'Orval 최신판은 8.46.0(2026-10-30)이고 판정은 보류다.', { from: '2026-10-30' }),
  C('e:project:sagae-viewer', 'mock_server', 'own kb-mock on Hono', null, 'state', 'UB', 'Own `kb-mock` on Hono + KB fixtures | n/a | **Adopt**', '목 서버는 Hono 위의 자체 kb-mock과 KB fixture로 채택한다.'),
  // conflict C1: ui-blocks adopts @hono/mcp, mcp-servers rejects it on the same day. R4 resolves it in favour of mcp-servers.
  C('e:library:hono-mcp', 'fit', 'adopt', null, 'state', 'UB', 'npm has 0.3.5. It is pre-1.0.', '@hono/mcp를 Hono 위 MCP 호스팅에 쓴다. 1.0 이전이라는 단서가 붙는다.', { key: 'honomcp-old', sup: 'honomcp-new', cg: 'cg-hono-mcp-fit', from: '2026-10-28' }),

  // ---- oss-viewers.md (OV)
  C('e:project:sagae-viewer', null, null, null, 'state', 'OV', 'No. No application found covers more than about half of the nine required views', '기존 앱 가운데 필요한 아홉 화면의 절반을 넘게 덮는 것은 없다.'),
  C('e:tool:gephi-lite', 'latest_version', '1.1.0', 'version', 'state', 'OV', 'v1.1.0 on 2026-10-06, GPL-3.0', 'Gephi Lite 최신판은 1.1.0(2026-10-06)이다.', { from: '2026-10-06' }),
  C('e:tool:gephi-lite', 'license', 'GPL-3.0', null, 'state', 'OV', 'v1.1.0 on 2026-10-06, GPL-3.0', 'Gephi Lite의 라이선스는 GPL-3.0이다.'),
  C('e:tool:gephi-lite', 'size_limit', '10k nodes or 20k edges', null, 'state', 'OV', 'no more than 10k nodes or 20k edges, at the moment', '관리자들은 노드 1만 개 또는 엣지 2만 개를 넘기지 말라고 밝혔다.', { stance: 'attributed', speaker: 'Gephi Lite maintainers' }),
  C('e:tool:gephi-lite', 'verdict', 'adopt (export target only)', null, 'state', 'OV', 'Verdict: adopt as an export target only.', 'Gephi Lite는 내보내기 대상으로만 채택한다.'),
  C('e:tool:datasette', 'verdict', 'adopt (optional sidecar)', null, 'state', 'OV', 'Verdict: adopt as an optional sidecar', 'Datasette는 선택적 곁가지로 채택한다.'),
  // unverified: an extractor claim without any evidence. Hidden from default reads (include_unverified=true shows it).
  C('e:tool:datasette', 'bitemporal_support', 'none', null, 'state', 'OV', null, 'Datasette는 이중 시간 질의를 기본으로 지원하지 않는다.', { ver: 'unverified' }),
  C('e:tool:datasette', 'contract_coupling', 'bypasses the contract', null, 'state', 'OV', 'The trap: it bypasses the contract.', 'Datasette는 계약을 우회한다. 저장 스키마에 결합된다는 함정이 있다.'),
  C('e:tool:graphiti', 'latest_version', '0.31.2', 'version', 'state', 'OV', 'v0.31.2 (2026-10-20), Apache-2.0', 'Graphiti 최신판은 0.31.2(2026-10-20)이다.', { from: '2026-10-20' }),
  C('e:tool:graphiti', 'temporal_model', 'bi-temporal with automatic fact invalidation', null, 'state', 'OV', 'explicit bi-temporal tracking with automatic fact invalidation', 'Graphiti는 이중 시간 추적과 자동 사실 무효화를 내세운다.', { stance: 'attributed', speaker: 'Graphiti README' }),
  C('e:tool:graphiti-lens', null, null, null, 'state', 'OV', "Nothing off-the-shelf understands Graphiti's bitemporal edges", '기성품 중 Graphiti의 이중 시간 엣지를 이해하는 것이 없다는 것이 graphiti-lens의 존재 이유다.', { stance: 'attributed', speaker: 'graphiti-lens README' }),
  C('e:tool:obsidian', 'latest_public_version', '1.15.0', 'version', 'state', 'OV', 'Desktop 1.15.0 on 2026-10-22', 'Obsidian 데스크톱 최신판은 1.15.0(2026-10-22)이다.', { key: 'obs-old', sup: 'obs-new', from: '2026-10-22' }),
  C('e:concept:korean-fts', null, null, null, 'state', 'OV', 'Korean search does not get solved by any app here.', '한국어 검색은 여기 조사한 어떤 앱도 해결하지 못한다. KB 색인 결정이다.'),
  C('e:concept:korean-fts', 'fts5_unicode61', 'no word segmentation', null, 'state', 'OV', 'FTS5 `unicode61` treats a contiguous letter run as one token, so no Korean word segmentation', 'FTS5 unicode61은 글자 연속을 토큰 하나로 봐서 한국어 단어 분리가 없다.', { stance: 'stated' }),

  // ---- trends.md (TR)
  C('e:project:sagae-kb', null, null, null, 'state', 'TR', 'The biggest design risk is in the contract, not the renderer.', '가장 큰 설계 위험은 렌더러가 아니라 계약에 있다.'),
  C('e:concept:bitemporal-model', null, null, null, 'howto', 'TR', 'Make time a global query context, not a separate view.', '시간을 별도 화면이 아니라 전역 질의 맥락으로 다룬다.'),
  C('e:project:sagae-viewer', null, null, null, 'howto', 'TR', 'The overview should be a map of communities, not a hairball.', '개요는 털뭉치가 아니라 커뮤니티 지도여야 한다.'),
  C('e:concept:korean-fts', 'min_token_length', '2 syllables', null, 'howto', 'TR', 'Korean search must handle 2-syllable nouns.', '한국어 검색은 두 음절 명사를 다뤄야 한다.'),
  C('e:library:embedding-atlas', 'webgl_fallback', 'true', null, 'state', 'TR', '"WebGPU with WebGL 2 fallback" is from a secondary source', 'Embedding Atlas에 WebGL 2 대체 경로가 있다는 것은 2차 출처 설명이다.', { key: 'atlas-old', sup: 'atlas-new', stance: 'attributed', speaker: 'secondary source' }),
  C('e:project:sagae-gateway', null, null, null, 'state', 'TR', 'The gateway got simpler.', '게이트웨이가 단순해졌다. 스펙 2026-07-28이 세션을 없앴다.'),

  // ---- http-gateway.md (HG)
  C('e:project:sagae-gateway', 'recommended_process_count', '1', 'process', 'howto', 'HG', 'One process is enough to start.', '처음에는 프로세스 하나로 충분하다.'),
  C('e:project:sagae-gateway', 'port', '8787', null, 'state', 'HG', 'ListenStream=127.0.0.1:8787', '게이트웨이는 127.0.0.1:8787에서 듣는다.', { cg: 'cg-gateway-port' }),
  C('e:project:sagae-gateway', 'node_cold_start_ms', '45', 'ms', 'state', 'HG', 'with about 45 ms cold first response', 'Node의 콜드 첫 응답은 약 45 ms다.', { key: 'cold-old', sup: 'cold-new', from: '2026-10-31' }),
  C('e:project:sagae-gateway', 'socket_activation_wakes_wsl', 'false', null, 'state', 'HG', 'Socket activation does not wake WSL.', '소켓 활성화는 WSL을 깨우지 않는다.'),
  C('e:project:sagae-kb', 'needs_daemon', 'false', null, 'state', 'HG', 'KB needs no daemon.', 'KB에는 상주 프로세스가 필요 없다.'),

  // ---- mcp-gateways.md (MG)
  // retroactive correction R6: the gateway report ranked agentgateway first, the verification re-ranked Hono first.
  C('e:decision:gateway-front-process', 'recommended_primary', 'agentgateway v1.7.0', null, 'state', 'MG', 'Primary: agentgateway v1.7.0.', '앞단 1순위로 agentgateway v1.7.0을 권고한다.', { key: 'front-old', sup: 'front-new', from: '2026-10-31' }),
  C('e:decision:gateway-front-process', 'recommended_fallback', '1MCP v0.39.7 + Caddy v2.11.7', null, 'state', 'MG', 'Fallback: 1MCP v0.39.7 for MCP, plus Caddy v2.11.7 for HTTP.', '대안은 MCP에 1MCP v0.39.7, HTTP에 Caddy v2.11.7이다.'),
  C('e:tool:agentgateway', 'openapi_3_1_support', 'false', null, 'state', 'MG', 'Its OpenAPI-to-MCP target cannot read OpenAPI 3.1, and the KB contract is 3.1.', 'agentgateway의 OpenAPI-MCP 대상은 OpenAPI 3.1을 읽지 못한다.'),
  C('e:tool:agentgateway', 'stdio_children', 'one per session', null, 'state', 'MG', 'It spawns stdio children per session, for every target that passes the condition. Nothing is pooled.', 'agentgateway는 세션마다 stdio 자식을 띄우고 풀링하지 않는다.'),
  C('e:tool:agentgateway', 'tool_search', 'false', null, 'state', 'MG', 'It has no tool-search feature.', 'agentgateway에는 도구 검색 기능이 없다.'),
  C('e:spec:mcp-2026-07-28', 'is_current_revision', 'true', null, 'state', 'MG', 'Current revision: `2026-07-28`', 'MCP의 현행 개정은 2026-07-28이다.', { from: '2026-07-28' }),
  C('e:feature:mcp-session-id', 'removed_in', '2026-07-28', 'spec', 'event', 'MG', '`initialize` handshake and `Mcp-Session-Id` removed.', '2026-07-28 개정에서 initialize 핸드셰이크와 Mcp-Session-Id가 제거됐다.', { from: '2026-07-28' }),
  C('e:feature:mcp-server-discover', 'introduced_in', '2026-07-28', 'spec', 'event', 'MG', 'New mandatory `server/discover`.', '2026-07-28 개정에서 server/discover가 필수로 추가됐다.', { from: '2026-07-28' }),
  C('e:feature:mcp-http-sse', 'deprecated_in', '2026-07-28', 'spec', 'event', 'MG', 'Roots, Sampling, Logging, HTTP+SSE transport. Minimum window twelve months.', 'HTTP+SSE 전송은 2026-07-28 개정에서 폐기 예고됐고 최소 유예는 12개월이다.', { from: '2026-07-28' }),
  C('e:library:mcp-sdk-server', 'latest_version', '2.4.0', 'version', 'state', 'MG', 'TypeScript `@modelcontextprotocol/server` 2.4.0 (2026-10-23)', 'TypeScript SDK @modelcontextprotocol/server 최신판은 2.4.0(2026-10-23)이다.', { from: '2026-10-23' }),
  C('e:product:claude-code', 'changelog_fix', '2.1.302', 'version', 'event', 'MG', 'Changelog 2.1.302 fixes servers that negotiate `2026-07-28` but omit `resultType`, `ttlMs` or `cacheScope`', 'Claude Code 2.1.302는 2026-07-28을 협상하면서 resultType, ttlMs, cacheScope를 빼먹는 서버를 고쳤다.'),
  C('e:spec:mcp-2026-07-28', 'dual_era', 'mandatory', null, 'howto', 'MG', 'Dual-era is mandatory.', '게이트웨이는 두 시대를 모두 다뤄야 한다.'),
  C('e:project:sagae-gateway', 'port', '8787', null, 'state', 'MG', 'default: { port: 8787, bindAddress: 127.0.0.1 }', 'agentgateway 스케치는 포트 8787에 127.0.0.1로 묶는다.', { cg: 'cg-gateway-port' }),

  // ---- mcp-servers.md (MS, Korean)
  C('e:project:sagae-gateway', 'base_stack', '공식 TypeScript SDK v2', null, 'state', 'MS', '기본 스택은 공식 TypeScript SDK v2다.', '기본 스택은 공식 TypeScript SDK v2다.'),
  C('e:project:sagae-gateway', 'server_shape', 'factory 패키지, 입구 셋', null, 'howto', 'MS', '서버는 factory 패키지로 만들고 입구를 셋 둔다.', '서버는 factory 패키지로 만들고 입구(stdio, 경로 마운트, in-process)를 셋 둔다.'),
  C('e:project:sagae-gateway', 'port', '7410', null, 'state', 'MS', 'http://127.0.0.1:7410', 'MCP 서버 조사의 예시 설정은 포트 7410을 쓴다.', { cg: 'cg-gateway-port' }),
  C('e:product:claude-code', 'structured_content_behavior', 'content를 버림', null, 'state', 'MS', 'Claude Code는 `structuredContent`가 있으면 그것만 모델에 넘기고 `content`를 버린다(이슈 #103396 열림).', 'structuredContent가 있으면 Claude Code는 그것만 모델에 넘기고 content를 버린다.'),
  C('e:spec:mcp-2026-07-28', 'current', '2026-07-28', null, 'state', 'MS', '현행 스펙은 2026-07-28이다.', '현행 스펙은 2026-07-28이다.', { from: '2026-07-28' }),
  C('e:library:mcp-sdk-server', 'verdict', 'adopt', null, 'state', 'MS', '2.4.0 (10-23) | Apache-2.0(신규)+MIT(기존) | 10-30 | Node 20+, Bun, Deno(README) | **채택**', '@modelcontextprotocol/server를 채택한다.'),
  C('e:library:mcp-hono', 'latest_version', '2.0.2', 'version', 'state', 'MS', '2.0.2 (10-02) | Apache-2.0 | 같은 저장소 | hono ^4.11.4 | **채택**(게이트웨이)', '@modelcontextprotocol/hono 최신판은 2.0.2(10-02)이고 게이트웨이용으로 채택한다.', { from: '2026-10-02' }),
  C('e:library:hono-mcp', 'fit', 'reject', null, 'state', 'MS', '0.3.5 (10-28) | MIT | 활동 있음 | peer가 SDK v1 | **기각**', '@hono/mcp는 peer가 SDK v1이라 기각한다.', { cg: 'cg-hono-mcp-fit', from: '2026-10-28' }),
  C('e:tool:fastmcp-ts', 'verdict', 'reject', null, 'state', 'MS', '1.9.0 (10-27) | Apache-2.0 | 활동 있음 | Node 22+, Express 의존 | **기각**', '@prefecthq/fastmcp-ts는 Express 의존 때문에 기각한다.'),
  C('e:tool:mcp-use', 'latest_version', '2.12.2', 'version', 'state', 'MS', '2.12.2 (10-29) | MIT | 10-30 | Node 22.22.2+, Bun 언급 없음 | 기본값 기각, MCP Apps 본격화 시 재검토', 'mcp-use 최신판은 2.12.2(10-29)이고 기본값으로는 기각한다.', { from: '2026-10-29' }),
  C('e:tool:fastmcp-py', 'latest_version', '4.1.4', 'version', 'state', 'MS', '4.1.4 (10-26) | Apache-2.0 | 10-31 | Python 3.10+, uv 권장 | Python 서버가 필요할 때의 기본값', 'Python FastMCP 최신판은 4.1.4(10-26)이고 Python 서버가 필요할 때의 기본값이다.', { from: '2026-10-26' }),
  C('e:project:sagae-kb', 'ownership', '저장소와 조회 의미', null, 'state', 'MS', 'KB가 저장소와 조회 의미(한국어 검색, 시점 조회, 민감도 기본 숨김)를 소유한다.', 'KB가 저장소와 조회 의미(한국어 검색, 시점 조회, 민감도 기본 숨김)를 소유한다.'),
  C('e:decision:contract-client-generator', 'proposed', 'openapi-typescript 7.13.0 + openapi-fetch 0.17.0', null, 'state', 'MS', '타입 생성은 `openapi-typescript` 7.13.0 + `openapi-fetch` 0.17.0을 제안한다', '타입 생성은 openapi-typescript 7.13.0과 openapi-fetch 0.17.0을 제안한다.'),
  // retroactive correction R3: the Korean report quoted npm's "modified" date as the release date.
  C('e:library:openapi-typescript', 'release_date', '2026-06-15', 'date', 'event', 'MS', 'npm 갱신 2026-06-15', 'openapi-typescript 7.13.0은 2026-06-15에 갱신됐다고 적었다.', { key: 'ot-date-old', sup: 'ot-date-new', from: '2026-02-11' }),
  C('e:concept:gateway-token-storage', 'bearer_header', 'Authorization: Bearer ${user_config.gateway_token}', null, 'state', 'MS', '"headers": { "Authorization": "Bearer ${user_config.gateway_token}" }', '플러그인 설정은 Authorization 헤더에 사용자 설정의 토큰을 싣는다.'),

  // ---- understand-kb-contract.md (KC), understand-token-tooling.md (TT)
  C('e:project:sagae-kb', 'read_contract', 'none yet', null, 'state', 'KC', 'There is no read contract yet, because there is no database yet.', '읽기 계약은 아직 없다. 데이터베이스가 아직 없기 때문이다.'),
  C('e:project:sagae-kb', 'maturity', 'pre-design', null, 'state', 'KC', 'Pre-design. No implementation of any layer', 'KB는 설계 이전 단계이고 어떤 층도 구현되지 않았다.'),
  C('e:project:sagae-viewer', null, null, null, 'howto', 'KC', 'Do not bind to a schema now.', '지금은 스키마에 묶이지 않는다.'),
  C('e:project:sagae-kb', null, null, null, 'state', 'KC', 'The planned read boundary was specified for Claude sessions, not a visual tool.', '계획된 읽기 경계는 시각 도구가 아니라 Claude 세션을 위해 정해졌다.'),
  C('e:tool:trail', 'identified_as', 'trail (Trail-Code)', null, 'state', 'TT', '"trailing" means `trail`', '"trailing"은 trail을 뜻한다.'),
  C('e:tool:rtk', 'wired_into_claude_code', 'false', null, 'state', 'TT', 'Neither tool is wired into Claude Code today, anywhere on this machine.', '두 도구 모두 이 머신의 어디에서도 Claude Code에 연결돼 있지 않다.'),
  C('e:tool:rtk', 'scope_limit', 'Bash output only', null, 'state', 'TT', 'It only touches Bash output.', 'rtk는 Bash 출력에만 손댄다.'),
  C('e:tool:rtk', 'scope_rule', '프로젝트 단위에서만', null, 'howto', 'TT', 'graft나, rtk 모두 프로젝트 단위에서만 동작했으면 좋겠어', '사용자는 graft와 rtk가 프로젝트 단위에서만 동작하길 원한다.', { stance: 'attributed', speaker: 'user:sagae' }),
];
