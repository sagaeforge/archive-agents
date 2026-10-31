// Claims read out of spike-results.md (SR), the five spike documents and four spike result files (JSON).
// The `auto*` functions turn the structured bullet lists of spike-results.md into claims, so that the fixture carries the
// real wording instead of retyped numbers. Their statements are templates, and the quotes are cut from the bullets verbatim.
import { C } from './claims-reports.mjs';

export const SPIKE_CLAIMS = [
  // ---- spike-results.md: verdicts of S1, one per candidate
  C('e:component:sdk-composition', 'passes_every_check', 'true', null, 'state', 'SR', 'Only candidate to pass every check, including through real Claude Code on the final revision', 'S1은 SDK v2 composition이 실제 Claude Code를 포함한 모든 검사를 통과한 유일한 후보라고 적었다.', { cg: 'cg-composition-readback' }),
  C('e:tool:agentgateway', 'verdict', 'partial', null, 'state', 'SR', 'agentgateway v1.7.0**: partial.', 'agentgateway v1.7.0의 S1 판정은 부분 통과다.'),
  C('e:tool:1mcp', 'verdict', 'partial', null, 'state', 'SR', '1MCP v0.39.7**: partial.', '1MCP v0.39.7의 S1 판정은 부분 통과다.'),
  C('e:tool:mcp-use', 'verdict', 'fail', null, 'state', 'SR', 'mcp-use 2.12.2 server.proxy()**: fail.', 'mcp-use 2.12.2 server.proxy()의 S1 판정은 실패다.'),
  C('e:tool:fastmcp-ts', 'verdict', 'fail', null, 'state', 'SR', 'fastmcp-ts 1.9.0 mount()/createProxy() (npm @prefecthq/fastmcp-ts)**: fail.', 'fastmcp-ts 1.9.0의 S1 판정은 실패다.'),
  C('e:component:sdk-composition', 'size_lines', '207', 'line', 'state', 'SR', 'Final 207 lines', 'composition의 최종 크기는 207줄이다.'),
  C('e:component:sdk-composition', 'resource_link_readback', 'works', null, 'state', 'SR', 'Fails on all four maintained candidates, works on the composition.', '되읽기는 유지되는 후보 넷에서 실패하고 composition에서는 된다.', { cg: 'cg-composition-readback' }),
  C('e:component:sdk-composition', 'resource_link_readback', 'works only for disjoint URIs', null, 'state', 'SR', 'Read-back works only for disjoint URIs.', '검토 결과 되읽기는 URI가 서로 겹치지 않을 때만 된다. URI가 충돌하면 엉뚱한 상류의 본문이 돌아온다.', { cg: 'cg-composition-readback' }),
  C('e:component:sdk-composition', 'cold_start_p50_ms', '247', 'ms', 'state', 'SR', 'composition 247 / 290 / 346 ms', 'composition의 첫 병합 tools/list까지 p50은 247 ms다.'),
  C('e:tool:agentgateway', 'cold_start_p50_ms', '125', 'ms', 'state', 'SR', 'agentgateway 125 / 144 / 182 ms', 'agentgateway의 첫 병합 tools/list까지 p50은 125 ms다.'),
  C('e:tool:1mcp', 'cold_start_p50_ms', '1202', 'ms', 'state', 'SR', '1MCP 1,202 / 1,243 / 1,289 ms', '1MCP의 첫 병합 tools/list까지 p50은 1,202 ms다.'),
  // This quote crosses code point 20,000, the end of the default /text window.
  C('e:tool:1mcp', 'port_open_p50_ms', '989', 'ms', 'state', 'SR', '1MCP 1,202 / 1,243 / 1,289 ms. Port open p50: 16, 150, 344, 384, 989 ms.', '1MCP의 포트 열림 p50은 989 ms로 후보 가운데 가장 느리다.', { key: 'window-crossing' }),
  C('e:tool:agentgateway', 'idle_gateway_rss_mb', '42.8', 'MB', 'state', 'SR', 'agentgateway 42.8 / 42.8, 198 / 108 MB, 3 (2 session children)', 'agentgateway의 유휴 게이트웨이 RSS는 42.8 MB다.'),
  C('e:tool:agentgateway', 'stdio_spawns_modern', 'every request', null, 'state', 'SR', 'agentgateway: every request, 8 of 8 and 25 of 25', '현대 클라이언트가 이중 시대 자식에게 요청하면 agentgateway는 매 요청마다 stdio를 띄운다.'),
  C('e:tool:1mcp', 'stdio_spawns_legacy_only_child', 'every call', null, 'state', 'SR', '1MCP: every call, 20 of 20, p50 147 ms', '구형 전용 자식에 현대 클라이언트가 호출하면 1MCP는 매 호출마다 띄운다.'),
  C('e:tool:agentgateway', 'call_timeout_default', '10 s', null, 'state', 'SR', 'agentgateway fails at 10 s by default (upstream call timeout)', 'agentgateway는 상류 호출 제한 기본값 10초에서 실패한다.'),
  C('e:tool:mcp-use', 'telemetry', 'PostHog by default', null, 'state', 'SR', 'mcp-use sends PostHog telemetry to eu.i.posthog.com by default', 'mcp-use는 기본으로 eu.i.posthog.com에 PostHog 원격 측정을 보낸다.'),
  C('e:tool:agentgateway', 'hot_add_upstream', 'YAML reload, about 0.55 s', null, 'state', 'SR', 'agentgateway YAML reload, about 0.55 s, no restart', 'agentgateway는 YAML 다시 읽기로 약 0.55초 만에 상류를 추가한다.'),
  C('e:tool:1mcp', 'hot_add_upstream', 'JSON reload, 0.8 to 1.1 s', null, 'state', 'SR', '1MCP JSON reload, about 0.8 to 1.1 s, no restart', '1MCP는 JSON 다시 읽기로 0.8~1.1초에 상류를 추가한다.'),
  // conflict: S2 measured a refusal window, the adversarial review says hanging is the default
  C('e:spike:s2-lifecycle', 'closed_port_behaviour', 'ECONNREFUSED for 50-400 ms, then hangs', null, 'state', 'SR', 'ECONNREFUSED for 50-400 ms after close (N=2), then hangs.', '닫힌 127.0.0.1 포트는 닫힌 뒤 50~400 ms는 ECONNREFUSED를 주고 그 뒤로는 멈춘다.', { cg: 'cg-closed-port' }),
  C('e:spike:s2-lifecycle', 'closed_port_behaviour', 'hanging is the default', null, 'state', 'SR', 'Hanging is the default for a down loopback port on this host.', '검토 결과 이 호스트에서 내려간 루프백 포트는 멈추는 것이 기본이다. 50~400 ms는 인용하면 안 된다.', { cg: 'cg-closed-port' }),
  C('e:tool:orval', 'types_only_mode', 'none', null, 'state', 'SR', 'Orval has no types-only mode, so Kubb pluginTs is the types-only exit.', 'S4는 Orval에 타입 전용 모드가 없다고 적었다.', { key: 'orval-modes-old', sup: 'orval-modes-new' }),
  C('e:tool:orval', 'types_only_mode', 'schema-only mode exists', null, 'state', 'SR', 'Orval has a schema-only mode.', '검토 결과 Orval에는 스키마 전용 모드가 있다.', { key: 'orval-modes-new' }),
  C('e:project:sagae-viewer', 'sigma4_default_hangul_labels', 'wrong syllables past page 0', null, 'state', 'SR', 'Past page 0 (244-748 glyphs by DPR) labels silently show wrong syllables and fragments', 'sigma 4 기본 라벨은 0쪽을 넘으면(DPR에 따라 244~748글리프) 엉뚱한 음절과 조각을 조용히 보여 준다.'),
  C('e:project:sagae-viewer', 'sigma4_overlay_fps', '165', 'fps', 'state', 'SR', '165 Hz at full size with 0.6/0.9 ms overlay JS', 'sigma 4와 canvas 겹침 라벨은 전체 크기에서 165 Hz를 낸다.', { cg: 'cg-overlay-fps' }),
  C('e:project:sagae-viewer', 'sigma4_overlay_fps', 'lower of two runs, at the vsync ceiling', null, 'state', 'SR', "fps sits at the vsync ceiling and cannot rank options", '검토 결과 fps는 수직동기 상한에 붙어 있어 선택지를 가르지 못한다.', { cg: 'cg-overlay-fps' }),
  C('e:project:sagae-viewer', 'schemathesis_cases', '6,466 with 0 failures', null, 'state', 'SR', 'Schemathesis ran 6,466 cases with 0 failures.', 'S4의 Schemathesis는 6,466건에서 실패 0이었다. 표본 스펙에 한정된 결과다.'),
  C('e:project:sagae-viewer', 'schemathesis_cases', '6,644 over 5 seeds, 0 failures', null, 'state', 'SR', '5 seeds 6,644 cases with 0 failures and 0 5xx', '검토에서 5개 시드로 다시 돌린 결과 6,644건에서 실패 0, 5xx 0이었다.'),
];

const PREFIX = { 's1': 'e:spike:s1-aggregation', 's2': 'e:spike:s2-lifecycle', 's3': 'e:spike:s3-graph', 's4': 'e:spike:s4-contract', 's5': 'e:spike:s5-scale' };
// Machine details of the host that the fixture does not need.
const SKIP_MEASUREMENTS = new Set(['Environment', 'Exact commands', 'Stand-ins', 'Versions and integrity']);
const cut = (s, n) => {
  const a = [...s];
  if (a.length <= n) return s;
  const head = a.slice(0, n).join('');
  const sp = head.lastIndexOf(' ');
  return sp > n * 0.6 ? head.slice(0, sp) : head;
};

/** Bullets "- **Title**: word. rest" under `### Verdicts` of Spike 2..5, and "### Measurements" of Spike 1. */
export function autoSpikeClaims(text) {
  const lines = text.split('\n');
  const out = [];
  let spike = null, section = null;
  for (const line of lines) {
    const h2 = /^## Spike (\d)/.exec(line);
    if (h2) { spike = h2[1]; section = null; continue; }
    if (/^## /.test(line)) { spike = null; section = null; continue; }
    const h3 = /^### (.+)/.exec(line);
    if (h3) { section = h3[1]; continue; }
    if (!spike || !line.startsWith('- **')) continue;
    const subject = PREFIX['s' + spike];
    const body = line.slice(2);
    const m = /^\*\*(.+?)\*\*: ?(.*)$/.exec(body);
    if (!m) continue;
    const [, title, rest] = m;
    if (section === 'Verdicts' && spike !== '1') {
      const w = /^(pass|partial|fail|not_tested)\b/.exec(rest);
      if (!w || !['fail', 'partial'].includes(w[1])) continue;
      out.push(C(subject, 'verdict', w[1], null, 'state', 'SR', cut(body, 110), `S${spike} 판정: ${title} — ${w[1]}.`, { qual: { item: title }, auto: true }));
    } else if (section === 'Measurements' && spike === '1' && !SKIP_MEASUREMENTS.has(title)) {
      out.push(C(subject, 'measurement', title, null, 'state', 'SR', cut(body, 110), `S1 측정 항목 "${title}"의 결과 기록.`, { qual: { item: title }, auto: true }));
    }
  }
  // adversarial review
  const start = lines.findIndex((l) => l.startsWith('## Adversarial review'));
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const m = /^- \*\*(contradicted|method_flaw|reproduced|not_rechecked)\*\* \[([^\]]+)\] (.*)$/.exec(line);
    if (!m) continue;
    const [, kind, tag, rest] = m;
    const sp = /^S(\d)/.exec(tag)?.[1] ?? /S(\d)/.exec(tag)?.[1] ?? '1';
    // S1 keeps every kind (it is the hub entity of the fixture); the other spikes keep the findings that changed a conclusion
    if (sp !== '1' && !['contradicted', 'method_flaw'].includes(kind)) continue;
    const subject = PREFIX['s' + (tag === 'All' ? '1' : sp)];
    out.push(C(subject, `review_${kind}`, kind, null, 'state', 'SR', cut(line.slice(2), 120), `적대적 검토(${kind}, ${tag}): ${cut(rest, 70)}`, { qual: { finding: cut(rest, 60) }, auto: true }));
  }
  return out;
}

export const SPIKE_DOC_CLAIMS = [
  // ---- upstream and guide documents captured during S1 (SP_*)
  C('e:tool:mcp-use', 'proxy_oauth', 'not supported', null, 'state', 'SP_PROXY', 'Proxy config deliberately supports bearer tokens and explicit authentication headers, but not automatic OAuth.', 'mcp-use 프록시는 베어러 토큰과 명시 인증 헤더는 지원하지만 자동 OAuth는 지원하지 않는다.', { stance: 'attributed', speaker: 'mcp-use docs' }),
  C('e:tool:mcp-use', 'client_package', '@mcp-use/client v2 (optional peer)', null, 'state', 'SP_PROXY', 'Proxying requires `@mcp-use/client` v2.', '프록시에는 @mcp-use/client v2가 필요하다.', { stance: 'attributed', speaker: 'mcp-use docs' }),
  C('e:library:mcp-hono', 'handler_mount', 'handler.fetch(c.req.raw)', null, 'howto', 'SP_HONO', 'takes the `Request` a Hono route already holds as `c.req.raw`', 'Hono 경로가 이미 가진 Request(c.req.raw)를 handler.fetch에 넘긴다.', { stance: 'attributed', speaker: 'MCP TypeScript SDK docs' }),
  C('e:tool:agentgateway', 'target_condition', 'CEL boolean excludes a target before it is contacted', null, 'state', 'SP_AGW', 'A target whose expression evaluates to `false` is excluded before', '조건식이 false인 대상은 초기화나 접촉 전에 제외된다.', { stance: 'attributed', speaker: 'agentgateway README' }),
  C('e:tool:1mcp-app', 'description', 'unified MCP runtime', null, 'state', 'SP_1MCP', '1MCP is the unified MCP runtime.', '1MCP는 통합 MCP 런타임이다.', { stance: 'attributed', speaker: '1MCP README' }),

  // ---- JSON result files (JP_*): evidence is a JSON Pointer into the normalized display body
  C('e:spike:s3-graph', 'distinct_syllables_1k', null, 'syllable', 'state', 'JP_SUMMARY', null, 'S3 1k 합성 페이로드에는 서로 다른 한글 음절이 1,797개 있다.', { jp: '/payload-1k/distinctSyllables', ver: 'parser_derived' }),
  C('e:spike:s3-graph', 'layout_ms_full', null, 'ms', 'state', 'JP_SUMMARY', null, 'S3 전체 페이로드(1만 노드, 약 5.1만 엣지)의 ForceAtlas2 배치는 31,733 ms 걸렸다.', { jp: '/payload-full/layoutMs', ver: 'parser_derived' }),
  C('e:spike:s3-graph', 'louvain_communities_full', null, 'community', 'state', 'JP_SUMMARY', null, 'S3 전체 페이로드의 Louvain 커뮤니티는 28개다.', { jp: '/payload-full/louvain/communities', ver: 'parser_derived' }),
  C('e:tool:agentgateway', 'cold_ready_p50_ms', null, 'ms', 'state', 'JP_BENCH', null, '벤치 원자료에서 agentgateway의 준비까지 p50은 127.3 ms다.', { jp: '/candidates/agentgateway/coldReadyMs/p50', ver: 'parser_derived' }),
  C('e:tool:1mcp', 'cold_ready_p50_ms', null, 'ms', 'state', 'JP_BENCH', null, '벤치 원자료에서 1MCP의 준비까지 p50은 1213.4 ms다.', { jp: '/candidates/1mcp/coldReadyMs/p50', ver: 'parser_derived' }),
  C('e:project:sagae-viewer', 'orca_fps_community_full_dash', null, 'fps', 'state', 'JP_ORCA', null, 'Orca 탭 측정에서 커뮤니티 전체 그래프, 점선 포함 구성의 fps는 160.6이다.', { jp: '/0/fps', ver: 'parser_derived' }),
];
