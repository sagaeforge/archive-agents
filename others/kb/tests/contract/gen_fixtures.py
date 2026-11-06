"""계약 fixture 생성기(합성 데이터). 사용: ops/bin/dev python tests/contract/gen_fixtures.py [--write | --check]

원천은 cfx_world.py(원장, CAS)와 이 파일의 사례 목록이다. 사례 목록은 요청과 이를 설명하는 태그를 정하고,
응답은 재생한 서버에서 받아 저장한다. --write는 docs/contracts/fixtures/를 다시 쓰고(옛 파일은 지운다),
--check는 디스크와 다른 점을 보고한다.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cfx_run as R   # noqa: E402
import cfx_world as W   # noqa: E402

CONTRACT_VERSION = "0.5.0"
LEGACY_FIRST_PARTY_VERSION = "0.4.0"  # Preserve the existing 0.4.0 response examples.

# 태그 -> 계약 9장 사례. test_fixture_cases.py가 모두 있는지 본다.
TAGS = {
    "supersede_chain": "대체 체인(결정적 주장 3세대)",
    "retroactive_correction": "소급 정정(유효 시점과 관측 시점이 어긋남)",
    "future_effective": "미래 발효 대체(효력일 전 두 주장 active, as_of_valid로 값 하나)",
    "dead_subject": "dead 주어: state는 status가 바뀌고 event는 유지, 판정 전 as-of",
    "superseded_subject": "superseded 주어",
    "revived": "번복(revived)",
    "merge_chain": "연쇄 병합(merged_into, merged_into_final, 옛 id 조회)",
    "korean_text": "한글 본문(조사, 한 음절 단어, 숫자 표기)",
    "emoji_offset": "이모지 뒤 인용 코드포인트 오프셋",
    "nfd_input": "NFD 입력",
    "hidden": "private, secret 레코드의 404",
    "sensitivity_raise": "민감도 상향과 visibility.revoked",
    "parallel_edges": "평행 엣지(같은 양끝의 두 관계)",
    "empty_search": "빈 검색 결과",
    "cursor_mismatch": "cursor_mismatch",
    "epoch_changed": "epoch_changed",
    "export_follow": "export 뒤 changes_cursor로 이어 받기",
    "tail_cursor": "꼬리의 문자열 커서",
    "series_reannounce": "시계열 재공시",
    "series_gap": "시계열 공백 구간",
    "first_party": "first_party(Markdown, 작성자, 버전, 백링크)",
    "held": "first_party 보류(mcp/ 응답)",
    "unknown_param": "모르는 파라미터 400 bad_param",
    "filter_syntax": "filter 복수 AND, 값 안의 ':', in 이스케이프",
    "sort_desc_tie": "sort 내림차순과 동률",
    "ids_param": "ids= 의 숨김, 없는 ID, 병합 ID",
    "node_id_kinds": "노드 ID 종류별 404",
    "search_kinds": "검색 항목 kind 네 종류",
    "not_modified": "304",
    "cache_control": "경로 구분별 Cache-Control",
    "as_of_unsupported": "as_of_unsupported",
    "truncated": "truncated=true",
    "total_null": "total=null",
    "overview_cursor": "개요 커서",
}


def _u(path, *params):
    """params: (이름, 값) 쌍. 값은 퍼센트 인코딩한다(':', ','는 그대로)."""
    if not params:
        return path
    return path + "?" + "&".join(f"{k}={quote(str(v), safe=':,')}" for k, v in params)


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Recorder:
    def __init__(self, app):
        self.app, self.cases, self.res = app, [], {}

    def run(self, cid, path, *, tags=(), ex=(), headers=None, method="GET", expect=None):
        assert cid not in self.res, cid
        case = {"id": cid, "path": path}
        if method != "GET":
            case["method"] = method
        if headers:
            case["headers"] = headers
        if tags:
            case["tags"] = list(tags)
        if ex:
            case["examples"] = list(ex)
        r = R.call(self.app, case)
        stored = R.to_stored(cid, r)
        if expect is not None:
            assert r.status == expect, (cid, path, r.status, r.body[:300])
        assert all(t in TAGS for t in tags), tags
        case["status"] = r.status
        self.cases.append(case)
        self.res[cid] = stored
        return stored

    def etag(self, cid):
        return self.res[cid]["headers"]["etag"]

    def body(self, cid):
        return self.res[cid]["body"]


def define_cases(rec: Recorder, rp) -> None:
    run = rec.run
    T = W
    o2 = iso(T.T2 + T.H * 4)     # T2 와 T3 사이
    o1 = iso(T.T1 + T.H)         # T1 직후
    o3 = iso(T.T3 + T.H * 2)     # T3 이후

    # ================================================================ meta, schema
    run("meta-ok", "/v1/meta", ex=["default"], tags=["cache_control"], expect=200)
    run("meta-304", "/v1/meta", headers={"If-None-Match": rec.etag("meta-ok")}, tags=["not_modified"], expect=304)
    run("meta-bad-param", _u("/v1/meta", ("x", 1)), tags=["unknown_param"], expect=400)
    run("meta-post", "/v1/meta", method="POST", expect=405)
    run("meta-forbidden-host", "/v1/meta", headers={"Host": "evil.example"}, expect=403)
    run("schema-ok", "/v1/schema", ex=["default"], expect=200)
    run("schema-304", "/v1/schema", headers={"If-None-Match": rec.etag("schema-ok")}, tags=["not_modified"], expect=304)
    run("schema-as-of-unsupported", _u("/v1/schema", ("as_of_valid", "2027-01-01")), tags=["as_of_unsupported"], expect=400)

    # ================================================================ overview
    run("overview-ok", "/v1/overview", ex=["default"], expect=200)
    run("overview-page1", _u("/v1/overview", ("limit", 3), ("edge_limit", 2)), tags=["truncated"], expect=200)
    cur = rec.body("overview-page1")["page"]["next_cursor"]
    run("overview-page2", _u("/v1/overview", ("limit", 3), ("edge_limit", 2), ("cursor", cur)), tags=["overview_cursor"], expect=200)
    run("overview-bad-param", _u("/v1/overview", ("limit", "abc")), expect=400)

    # ================================================================ nodes (표)
    run("nodes-ok", "/v1/nodes", ex=["default"], expect=200)
    run("nodes-repo-sort-desc", _u("/v1/nodes", ("type", "Repo"), ("sort", "-stars")), tags=["sort_desc_tie"], expect=200)
    run("nodes-repo-sort-asc", _u("/v1/nodes", ("type", "Repo"), ("sort", "stars")), tags=["sort_desc_tie"], expect=200)
    run("nodes-filter-and", _u("/v1/nodes", ("type", "Repo"), ("filter", "lang:eq:go"), ("filter", "stars:gte:10")), tags=["filter_syntax"], expect=200)
    run("nodes-filter-colon", _u("/v1/nodes", ("type", "Repo"), ("filter", "label:eq:a:b:c")), tags=["filter_syntax"], expect=200)
    run("nodes-label-prefix", _u("/v1/nodes", ("type", "Repo"), ("filter", "label:prefix:a:b:")), tags=["filter_syntax"], expect=200)
    run("nodes-filter-in-escape", _u("/v1/nodes", ("type", "Repo"), ("filter", "label:in:a\\,b,zeta")), tags=["filter_syntax"], expect=200)
    run("nodes-limit-2", _u("/v1/nodes", ("type", "Repo"), ("limit", 2), ("sort", "-stars")), tags=["truncated"], expect=200)
    cur = rec.body("nodes-limit-2")["page"]["next_cursor"]
    run("nodes-limit-2-next", _u("/v1/nodes", ("type", "Repo"), ("limit", 2), ("sort", "-stars"), ("cursor", cur)), expect=200)
    run("nodes-cursor-sort-mismatch", _u("/v1/nodes", ("type", "Repo"), ("limit", 2), ("sort", "stars"), ("cursor", cur)),
        tags=["cursor_mismatch"], expect=400)
    run("nodes-ids", _u("/v1/nodes", ("ids", "e:tool:ma,e:tool:mc,f-priv,f-sec,e:none:zz")), tags=["ids_param", "hidden"], expect=200)
    run("nodes-bad-filter", _u("/v1/nodes", ("filter", "nope:eq:1")), tags=["filter_syntax"], expect=400)
    run("nodes-type-and-types", _u("/v1/nodes", ("type", "Repo"), ("types", "Tool")), expect=400)
    run("nodes-304", "/v1/nodes", headers={"If-None-Match": rec.etag("nodes-ok")}, tags=["not_modified"], expect=304)

    # ================================================================ nodes/{id}
    run("node-ok", "/v1/nodes/e:feature:history", ex=["default"], expect=200)
    run("node-304", "/v1/nodes/e:feature:history", headers={"If-None-Match": rec.etag("node-ok")}, tags=["not_modified"], expect=304)
    run("node-not-found", "/v1/nodes/e:tool:no-such", expect=404)
    run("node-bad-param", _u("/v1/nodes/e:feature:history", ("include", "nope")), expect=400)
    run("node-private-hidden", "/v1/nodes/f-priv", tags=["hidden"], expect=404)
    run("node-secret-hidden", "/v1/nodes/f-sec", tags=["hidden"], expect=404)
    run("node-raised-hidden", "/v1/nodes/f-raise", tags=["hidden", "sensitivity_raise"], expect=404)
    run("node-raised-observed-before", _u("/v1/nodes/f-raise", ("as_of_observed", o1)), tags=["hidden", "sensitivity_raise"])
    run("node-merged-old", "/v1/nodes/e:tool:ma", tags=["merge_chain"], expect=200)
    run("node-merged-middle", "/v1/nodes/e:tool:mb", tags=["merge_chain"], expect=200)
    run("node-merged-final", "/v1/nodes/e:tool:mc", tags=["merge_chain"], expect=200)
    run("node-dead-default", "/v1/nodes/e:tool:dead", tags=["dead_subject"])
    run("node-dead-all", _u("/v1/nodes/e:tool:dead", ("status", "all")), tags=["dead_subject"])
    run("node-superseded-subject", _u("/v1/nodes/e:tool:old", ("status", "all")), tags=["superseded_subject"])
    run("node-revived", "/v1/nodes/e:tool:revived", tags=["revived"], expect=200)
    run("node-first-party", _u("/v1/nodes/f-1", ("include", "claims,edges,body")), tags=["first_party"], expect=200)
    run("node-agent-record", "/v1/nodes/f-agent", tags=["first_party"], expect=200)
    run("node-backlinks", _u("/v1/nodes/e:tool:x", ("include", "claims,edges,backlinks")), tags=["first_party"], expect=200)
    run("node-parallel", _u("/v1/nodes/e:tool:x", ("include", "edges")), tags=["parallel_edges"], expect=200)
    run("node-claim-evidence-emoji", "/v1/nodes/c-emoji", tags=["emoji_offset"], expect=200)
    run("node-claim-evidence-nfd", "/v1/nodes/c-nfd", tags=["nfd_input"], expect=200)
    # 노드 ID 종류: 있는 ID와 없는 ID
    kinds = [("e:", "e:tool:x", "e:tool:zz"), ("c-", "c-1", "c-zz"), ("n-", "n-1", "n-zz"), ("f-", "f-1", "f-zz"), ("s:", "s:rank", "s:zz"),
             ("src:", "src:a", "src:zz"), ("t-", "t-1", "t-zz"), ("d-", "d-n-1", "d-zz"), ("r-", "r-01", "r-zz")]
    for pre, have, miss in kinds:
        k = pre.rstrip(":-")
        run(f"node-kind-{k}-exists", f"/v1/nodes/{have}", tags=["node_id_kinds"])
        run(f"node-kind-{k}-missing", f"/v1/nodes/{miss}", tags=["node_id_kinds"], expect=404)

    # ================================================================ nodes/{id}/claims
    run("claims-ok", "/v1/nodes/e:tool:alpha/claims", ex=["default"], expect=200)
    run("claims-304", "/v1/nodes/e:tool:alpha/claims", headers={"If-None-Match": rec.etag("claims-ok")}, tags=["not_modified"], expect=304)
    run("claims-not-found", "/v1/nodes/e:tool:no-such/claims", expect=404)
    run("claims-bad-param", _u("/v1/nodes/e:tool:alpha/claims", ("limit", 0)), expect=400)
    run("claims-chain-all", _u("/v1/nodes/e:policy:ypp/claims", ("status", "all")), tags=["supersede_chain"], expect=200)
    run("claims-chain-default", "/v1/nodes/e:policy:ypp/claims", tags=["supersede_chain"], expect=200)
    run("claims-retro-now", "/v1/nodes/e:policy:retro/claims", tags=["retroactive_correction"], expect=200)
    run("claims-retro-observed-before", _u("/v1/nodes/e:policy:retro/claims", ("as_of_observed", o2), ("as_of_valid", "2024-07-01")),
        tags=["retroactive_correction"], expect=200)
    run("claims-retro-observed-after", _u("/v1/nodes/e:policy:retro/claims", ("as_of_observed", o3), ("as_of_valid", "2024-07-01")),
        tags=["retroactive_correction"], expect=200)
    run("claims-future-both-active", "/v1/nodes/e:policy:future/claims", tags=["future_effective"], expect=200)
    run("claims-future-before", _u("/v1/nodes/e:policy:future/claims", ("as_of_valid", "2027-02-01")), tags=["future_effective"], expect=200)
    run("claims-future-after", _u("/v1/nodes/e:policy:future/claims", ("as_of_valid", "2027-04-01")), tags=["future_effective"], expect=200)
    run("claims-dead-default", "/v1/nodes/e:tool:dead/claims", tags=["dead_subject"], expect=200)
    run("claims-dead-status", _u("/v1/nodes/e:tool:dead/claims", ("status", "dead")), tags=["dead_subject"], expect=200)
    run("claims-dead-observed-before", _u("/v1/nodes/e:tool:dead/claims", ("as_of_observed", o2)), tags=["dead_subject"], expect=200)
    run("claims-superseded-subject", _u("/v1/nodes/e:tool:old/claims", ("status", "superseded")), tags=["superseded_subject"], expect=200)
    run("claims-revived", "/v1/nodes/e:tool:revived/claims", tags=["revived"], expect=200)
    run("claims-merged-final", "/v1/nodes/e:tool:mc/claims", tags=["merge_chain"], expect=200)

    # ================================================================ nodes/{id}/edges
    run("edges-ok", "/v1/nodes/e:product:p/edges", ex=["default"], expect=200)
    run("edges-304", "/v1/nodes/e:product:p/edges", headers={"If-None-Match": rec.etag("edges-ok")}, tags=["not_modified"], expect=304)
    run("edges-not-found", "/v1/nodes/e:tool:no-such/edges", expect=404)
    run("edges-bad-param", _u("/v1/nodes/e:product:p/edges", ("direction", "up")), expect=400)
    run("edges-parallel", _u("/v1/nodes/e:tool:alpha/edges", ("direction", "in")), tags=["parallel_edges"], expect=200)
    run("edges-merged-final", "/v1/nodes/e:tool:mc/edges", tags=["merge_chain"], expect=200)

    # ================================================================ nodes/{id}/body
    run("body-ok", "/v1/nodes/f-1/body", ex=["default"], tags=["first_party"], expect=200)
    run("body-window", _u("/v1/nodes/f-1/body", ("start", 3), ("max_chars", 8)), tags=["first_party"], expect=200)
    run("body-304", "/v1/nodes/f-1/body", headers={"If-None-Match": rec.etag("body-ok")}, tags=["not_modified"], expect=304)
    run("body-hidden", "/v1/nodes/f-priv/body", tags=["hidden"], expect=404)
    run("body-bad-param", _u("/v1/nodes/f-1/body", ("start", -1)), expect=400)

    # ================================================================ nodes/{id}/neighbors
    run("neighbors-ok", "/v1/nodes/e:product:p/neighbors", ex=["default"], expect=200)
    run("neighbors-304", "/v1/nodes/e:product:p/neighbors", headers={"If-None-Match": rec.etag("neighbors-ok")}, tags=["not_modified"], expect=304)
    run("neighbors-depth-2", _u("/v1/nodes/e:feature:history/neighbors", ("depth", 2)), expect=200)
    run("neighbors-limit", _u("/v1/nodes/e:product:p/neighbors", ("limit", 1)), tags=["truncated"], expect=200)
    run("neighbors-parallel", "/v1/nodes/e:tool:x/neighbors", tags=["parallel_edges"], expect=200)
    run("neighbors-merged-old", "/v1/nodes/e:tool:ma/neighbors", tags=["merge_chain"], expect=200)
    run("neighbors-not-found", "/v1/nodes/e:tool:no-such/neighbors", expect=404)
    run("neighbors-bad-param", _u("/v1/nodes/e:product:p/neighbors", ("depth", 9)), expect=400)

    # ================================================================ nodes/{id}/history, claims/{id}, edges/{id}
    run("history-ok", "/v1/nodes/e:policy:ypp/history", ex=["default"], tags=["supersede_chain"], expect=200)
    run("history-304", "/v1/nodes/e:policy:ypp/history", headers={"If-None-Match": rec.etag("history-ok")}, tags=["not_modified"], expect=304)
    run("history-retro", "/v1/nodes/c-retro/history", tags=["retroactive_correction"], expect=200)
    run("history-revived", "/v1/nodes/e:tool:revived/history", tags=["revived"], expect=200)
    run("history-dead-claim", "/v1/nodes/c-dead-state/history", tags=["dead_subject"], expect=200)
    run("history-first-party", "/v1/nodes/f-1/history", tags=["first_party"], expect=200)
    run("history-not-found", "/v1/nodes/e:tool:no-such/history", expect=404)
    run("history-as-of-unsupported", _u("/v1/nodes/e:policy:ypp/history", ("as_of_valid", "2027-01-01")), tags=["as_of_unsupported"], expect=400)
    run("claim-ok", "/v1/claims/c-1", ex=["default"], expect=200)
    run("claim-304", "/v1/claims/c-1", headers={"If-None-Match": rec.etag("claim-ok")}, tags=["not_modified"], expect=304)
    run("claim-not-found", "/v1/claims/c-no-such", expect=404)
    run("claim-bad-param", _u("/v1/claims/c-1", ("x", 1)), tags=["unknown_param"], expect=400)
    run("claim-dead", "/v1/claims/c-dead-state", tags=["dead_subject"], expect=200)
    run("claim-retro-before", _u("/v1/claims/c-retro", ("as_of_observed", o2), ("as_of_valid", "2024-07-01")), tags=["retroactive_correction"], expect=200)
    run("claim-retro-after", _u("/v1/claims/c-retro", ("as_of_observed", o3), ("as_of_valid", "2024-07-01")), tags=["retroactive_correction"], expect=200)
    run("claim-chain-3", "/v1/claims/c-chain-3", tags=["supersede_chain"], expect=200)
    run("edge-ok", "/v1/edges/r-01", ex=["default"], expect=200)
    run("edge-304", "/v1/edges/r-01", headers={"If-None-Match": rec.etag("edge-ok")}, tags=["not_modified"], expect=304)
    run("edge-not-found", "/v1/edges/r-no-such", expect=404)
    run("edge-bad-param", _u("/v1/edges/r-01", ("x", 1)), tags=["unknown_param"], expect=400)
    run("edge-parallel-1", "/v1/edges/r-par-1", tags=["parallel_edges"], expect=200)
    run("edge-parallel-2", "/v1/edges/r-par-2", tags=["parallel_edges"], expect=200)

    # ================================================================ search, facets, counts
    run("search-ok", _u("/v1/search", ("q", "위젯")), ex=["default"], tags=["search_kinds", "korean_text"], expect=200)
    run("search-304", _u("/v1/search", ("q", "위젯")), headers={"If-None-Match": rec.etag("search-ok")}, tags=["not_modified"], expect=304)
    run("search-josa", _u("/v1/search", ("q", "위젯을")), tags=["korean_text"], expect=200)
    run("search-one-syllable", _u("/v1/search", ("q", "달")), tags=["korean_text"], expect=200)
    run("search-number", _u("/v1/search", ("q", "4000시간")), tags=["korean_text"], expect=200)
    run("search-number-comma", _u("/v1/search", ("q", "4,000시간")), tags=["korean_text"], expect=200)
    for k in ("claim", "record", "entity", "passage"):
        run(f"search-kind-{k}", _u("/v1/search", ("q", "위젯" if k != "entity" else "도구"), ("kinds", k)), tags=["search_kinds"], expect=200)
    run("search-empty", _u("/v1/search", ("q", "존재하지않는말")), tags=["empty_search", "total_null"], expect=200)
    run("search-limit-1", _u("/v1/search", ("q", "위젯"), ("limit", 1)), tags=["total_null"], expect=200)
    scur = rec.body("search-limit-1")["page"]["next_cursor"]
    run("search-limit-1-next", _u("/v1/search", ("q", "위젯"), ("limit", 1), ("cursor", scur)), expect=200)
    run("search-hybrid", _u("/v1/search", ("q", "위젯"), ("mode", "hybrid")), expect=200)
    run("search-bad-param", "/v1/search", expect=400)
    run("facets-ok", "/v1/facets", ex=["default"], expect=200)
    run("facets-q", _u("/v1/facets", ("q", "위젯")), tags=["korean_text"], expect=200)
    run("facets-304", "/v1/facets", headers={"If-None-Match": rec.etag("facets-ok")}, tags=["not_modified"], expect=304)
    run("facets-bad-param", _u("/v1/facets", ("filter", "nonesuch:eq:1")), tags=["filter_syntax"], expect=400)
    run("counts-ok", _u("/v1/counts", ("bucket", "day"), ("field", "recorded_at")), ex=["default"], expect=200)
    run("counts-304", _u("/v1/counts", ("bucket", "day"), ("field", "recorded_at")), headers={"If-None-Match": rec.etag("counts-ok")},
        tags=["not_modified"], expect=304)
    run("counts-bad-param", _u("/v1/counts", ("bucket", "year")), expect=400)

    # ================================================================ series
    run("series-ok", "/v1/series/s:rank", ex=["default"], tags=["series_reannounce", "series_gap"], expect=200)
    run("series-304", "/v1/series/s:rank", headers={"If-None-Match": rec.etag("series-ok")}, tags=["not_modified"], expect=304)
    run("series-bucket-month", _u("/v1/series/s:rank", ("bucket", "month")), expect=200)
    run("series-observed-before-reannounce", _u("/v1/series/s:rank", ("as_of_observed", o2)), tags=["series_reannounce"], expect=200)
    run("series-from-after-gap", _u("/v1/series/s:rank", ("from", "2027-01-07")), tags=["series_gap"], expect=200)
    run("series-not-found", "/v1/series/s:no-such", expect=404)
    run("series-bad-param", _u("/v1/series/s:rank", ("bucket", "year")), expect=400)

    # ================================================================ snapshots
    run("snapshot-ok", "/v1/snapshots/n-1", ex=["default"], tags=["cache_control"], expect=200)
    run("snapshot-304", "/v1/snapshots/n-1", headers={"If-None-Match": rec.etag("snapshot-ok")}, tags=["not_modified"], expect=304)
    run("snapshot-not-found", "/v1/snapshots/n-no-such", expect=404)
    run("snapshot-bad-param", _u("/v1/snapshots/n-1", ("x", 1)), tags=["unknown_param"], expect=400)
    run("text-ok", "/v1/snapshots/n-1/text", ex=["default"], tags=["korean_text"], expect=200)
    run("text-304", "/v1/snapshots/n-1/text", headers={"If-None-Match": rec.etag("text-ok")}, tags=["not_modified"], expect=304)
    run("text-emoji", "/v1/snapshots/n-emoji/text", tags=["emoji_offset"], expect=200)
    run("text-nfd", "/v1/snapshots/n-nfd/text", tags=["nfd_input"], expect=200)
    run("text-window", _u("/v1/snapshots/n-1/text", ("start", 5), ("max_chars", 10)), expect=200)
    run("text-not-found", "/v1/snapshots/n-no-such/text", expect=404)
    run("text-bad-param", _u("/v1/snapshots/n-1/text", ("start", "x")), expect=400)
    run("raw-ok", "/v1/snapshots/n-raw/raw", ex=["default"], tags=["cache_control"], expect=200)
    run("raw-304", "/v1/snapshots/n-raw/raw", headers={"If-None-Match": rec.etag("raw-ok")}, tags=["not_modified"], expect=304)
    run("raw-range", "/v1/snapshots/n-raw/raw", headers={"Range": "bytes=0-9"}, ex=["default"], expect=206)
    run("raw-range-unsatisfiable", "/v1/snapshots/n-raw/raw", headers={"Range": "bytes=99999-"}, expect=416)
    run("raw-gone", "/v1/snapshots/n-1/raw", expect=410)
    run("raw-not-found", "/v1/snapshots/n-no-such/raw", expect=404)
    run("raw-bad-param", _u("/v1/snapshots/n-raw/raw", ("x", 1)), tags=["unknown_param"], expect=400)

    # ================================================================ changes
    run("changes-ok", "/v1/changes", ex=["default"], tags=["total_null"], expect=200)
    run("changes-304", "/v1/changes", headers={"If-None-Match": rec.etag("changes-ok")}, tags=["not_modified"], expect=304)
    run("changes-limit-2", _u("/v1/changes", ("limit", 2)), tags=["truncated", "total_null"], expect=200)
    run("changes-kinds", _u("/v1/changes", ("kinds", "record.put"), ("origin", "first_party")), expect=200)
    run("changes-revoked", _u("/v1/changes", ("kinds", "claim.assert"), ("limit", 500)), tags=["sensitivity_raise"], expect=200)
    run("changes-cursor-mismatch", _u("/v1/changes", ("cursor", "zzz")), tags=["cursor_mismatch"], expect=400)
    from kb.read.envelope import encode_cursor
    run("changes-epoch-changed", _u("/v1/changes", ("cursor", encode_cursor({"e": 1, "s": 3}))), tags=["epoch_changed"], expect=410)
    run("changes-bad-param", _u("/v1/changes", ("origin", "alien")), expect=400)
    run("export-manifest-ok", "/v1/export/graph/manifest", ex=["default"], tags=["cache_control"], expect=200)
    mcur = rec.body("export-manifest-ok")["data"]["changes_cursor"]
    run("changes-after-export", _u("/v1/changes", ("cursor", mcur)), tags=["export_follow"], expect=200)
    tail = rec.body("changes-after-export")["page"]["next_cursor"]
    run("changes-tail", _u("/v1/changes", ("cursor", tail)), tags=["tail_cursor"], expect=200)

    # ================================================================ export
    run("export-manifest-304", "/v1/export/graph/manifest", headers={"If-None-Match": rec.etag("export-manifest-ok")}, tags=["not_modified"], expect=304)
    run("export-manifest-bad-param", _u("/v1/export/graph/manifest", ("x", 1)), tags=["unknown_param"], expect=400)
    run("export-core", _u("/v1/export/graph", ("profile", "core")), ex=["default"], expect=200)
    run("export-full", _u("/v1/export/graph", ("profile", "full")), expect=200)
    run("export-304", _u("/v1/export/graph", ("profile", "core")), headers={"If-None-Match": rec.etag("export-core")}, tags=["not_modified"], expect=304)
    run("export-bad-param", _u("/v1/export/graph", ("profile", "x")), expect=400)

    # ================================================================ ops (잠정)
    run("ops-freshness-ok", "/v1/ops/freshness", ex=["default"], expect=200)
    run("ops-freshness-bad-param", _u("/v1/ops/freshness", ("x", 1)), tags=["unknown_param"], expect=400)
    run("ops-tickets-ok", "/v1/ops/tickets", ex=["default"], expect=200)
    run("ops-tickets-bad-param", _u("/v1/ops/tickets", ("limit", 0)), expect=400)
    run("ops-runs-ok", "/v1/ops/runs", ex=["default"], expect=200)
    run("ops-runs-limit-1", _u("/v1/ops/runs", ("limit", 1)), tags=["truncated"], expect=200)
    run("ops-runs-bad-param", _u("/v1/ops/runs", ("limit", 0)), expect=400)
    run("ops-metrics-ok", "/v1/ops/metrics", ex=["default"], expect=200)
    run("ops-metrics-bad-param", _u("/v1/ops/metrics", ("x", 1)), tags=["unknown_param"], expect=400)


def held_fixture(home: Path) -> dict:
    """first_party 게이트가 닫힌 저장소에 kb_put을 보내면 보류된다. 원장에 없으므로 mcp/ 응답으로 둔다."""
    from kb.core import ledger
    from kb.project import rebuild
    from kb.write import put_record
    old = {k: os.environ.get(k) for k in ("KB_HOME", "KB_CONFIG_DIR", "KB_MCP_SESSION")}
    os.environ["KB_HOME"], os.environ["KB_CONFIG_DIR"] = str(home), str(home / "config")
    os.environ.pop("KB_MCP_SESSION", None)
    (home / "config").mkdir(parents=True, exist_ok=True)
    try:
        led = ledger.open_ledger()
        try:
            rebuild(led=led)
        finally:
            led.close()
        rec = {"type": "Decision", "title": "합성 결정", "body": "합성 본문", "sensitivity": "internal", "props": {"status": "accepted"}}
        with R.fixed_clock(W.NOW_MS):
            r = put_record(rec, "fixture-held-1", "mcp", "s-fixture")
        assert r.held, r.as_dict()
        return {"tool": "kb_put", "request": {"record": rec, "idempotency_key": "fixture-held-1"},
                "response": r.as_dict(), "tags": ["held"], "note": "합성 데이터. first_party 게이트가 닫혀 있어 spool/fp-held에 남는다."}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def first_party_packet() -> dict:
    """승인된 미배포 계약의 합성 예다. HTTP 재생 결과와 분리한다."""
    import hashlib
    import copy

    artifact = json.loads((R.REPO / "docs/contracts/first-party-secret-rules-v1.json").read_text(encoding="utf-8"))
    sha = hashlib.sha256(json.dumps(artifact, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()
    spec = yaml.safe_load((R.REPO / "docs/contracts/openapi.yaml").read_text(encoding="utf-8"))
    inactive = {"fp_gate": False, "editor_routes": [], "private_open": False,
                "hitl": {"available": False, "trust_store": "missing", "rp_ids": []},
                "secret_rules": {"version": None, "sha": None}}
    ready = {"fp_gate": True, "editor_routes": ["POST /v1/records", "PUT /v1/records/{id}"],
             "private_open": True,
             "hitl": {"available": True, "trust_store": "ready", "rp_ids": [
                 {"rp_id": "localhost", "allowed_origins": ["http://localhost:4812"], "registered": True}]},
             "secret_rules": {"version": artifact["version"], "sha": sha}}
    packet = {"synthetic": True, "contract_version": LEGACY_FIRST_PARTY_VERSION,
              "note": "승인된 계약 예시. 실제 HTTP 동작이나 현재 준비 상태의 실행 결과가 아니다.",
              "meta_unready": inactive, "meta_ready": ready,
              "deployment": copy.deepcopy(inactive), "cases": []}
    fid, tid, run = "f-fixture-page", "f-fixture-spec", "t-fixture-run"
    record = {"type": "Page", "title": "합성 문서", "body": "한글😀 합성 본문",
              "body_format": "markdown", "sensitivity": "private", "props": {}, "links": []}
    payload_sha = hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True,
                                            separators=(",", ":")).encode()).hexdigest()
    base = {"id": fid, "version": 1, "seq": 101, "replayed": False, "unchanged": False,
            "projected": True, "spooled": False, "held": False, "write_ref": None,
            "payload_sha": payload_sha, "quarantined": False, "warnings": [], "reason": None,
            "actor": "app:loupe", "claimed_author": "user:sagae", "generated_by": "app:loupe:save"}

    def envelope(data):
        return {"schema_version": LEGACY_FIRST_PARTY_VERSION, "epoch": 1, "build_id": "g-fixture",
                "data_as_of": "2026-11-05T00:00:00Z", "applied_seq": 101,
                "as_of": {"valid": None, "observed": None}, "degraded": [], "data": data}

    def problem(code, instance="/v1/records", **extra):
        err = spec["x-first-party-errors"][code]
        return dict(type="https://kb.local/problems/" + code.replace("_", "-"),
                    title=code.replace("_", " "), status=err["status"], detail=err["detail"],
                    code=code, instance=instance, **extra)

    def add(cid, method, path, status, response, request=None):
        if request is not None and "payload_sha" in response:
            if "record" in request:
                content = {k: v for k, v in request["record"].items() if k != "expected_version"}
            else:
                # tombstone의 정규 본문도 이전 Page의 해시를 재사용하지 않는다.
                content = {"id": response["id"], "reason": request["reason"]}
            response["payload_sha"] = hashlib.sha256(json.dumps(
                content, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                allow_nan=False).encode("utf-8")).hexdigest()
        case = {"id": cid, "method": method, "path_template": path, "status": status,
                "headers": {"cache-control": "no-store"}, "response": response}
        if request is not None:
            case["request"] = request
        packet["cases"].append(case)

    request = {"idempotency_key": "loupe:c:synthetic-draft", "change": "save", "record": record}
    add("create", "POST", "/v1/records", 201, copy.deepcopy(base), copy.deepcopy(request))
    edit = copy.deepcopy(request)
    edit["idempotency_key"] = "loupe:e:f-fixture-page:v1:save:r2"
    edit["record"]["expected_version"] = 1
    add("edit", "PUT", "/v1/records/{id}", 200, dict(base, version=2, seq=102), edit)
    current = {"version": 2, "status": "active", "payload_sha": payload_sha,
               "actor": "app:loupe", "claimed_author": "user:sagae", "generated_by": "app:loupe:save",
               "recorded_at": "2026-11-05T00:00:00Z", "title": record["title"], "body": record["body"],
               "body_truncated": False, "props": {}, "links": []}
    add("conflict", "PUT", "/v1/records/{id}", 409, problem("version_conflict", current=current), copy.deepcopy(edit))
    add("hidden-404", "PUT", "/v1/records/{id}", 404, problem("not_found"), copy.deepcopy(edit))
    add("tombstone", "POST", "/v1/records/{id}/tombstone", 200, dict(base, version=3, seq=103),
        {"idempotency_key": "loupe:t:f-fixture-page:v2", "change": "save", "expected_version": 2, "reason": "합성 문서로 합침"})
    add("promote", "POST", "/v1/records/{id}/promote", 201,
        dict(base, id=tid, seq=104, promoted_from={"id": "f-fixture-note", "version": 4},
             research={"state": "budget_unavailable"}),
        {"idempotency_key": "loupe:p:f-fixture-note:v4", "change": "save", "to": "topic", "memo_version": 4,
         "record": {"title": "합성 연구", "body": "조사 범위", "props": {"export_llm": False, "export_query": False}}})
    secret = copy.deepcopy(request)
    secret["record"]["body"] = "한글😀-----BEGIN PRIVATE KEY-----"
    hit = {"field": "record.body", "rule": "kb-private-key-header", "start": 3, "end": 30, "start_u16": 4, "end_u16": 31}
    add("secret-reject", "POST", "/v1/records", 422, problem("secret_detected", stored=False, hits=[hit]), copy.deepcopy(secret))
    secret["on_secret"] = "quarantine"
    add("quarantine-save", "POST", "/v1/records", 201,
        dict(base, quarantined=True, sensitivity="secret", warnings=["secret_detected:kb-private-key-header"]), secret)
    add("spool-reference", "GET", "/v1/writes/{ref}", 200,
        envelope({"ref": "w-fixture", "state": "failed", "id": fid, "version": None, "code": "version_conflict"}))
    research = {"spec": tid, "spec_version": 2, "topic": "e:topic:fixture", "run": run,
                "existing": False, "state": "queued", "seq": 105, "replayed": False,
                "status_url": "/v1/topics/" + tid + "/research"}
    add("research-request", "POST", "/v1/topics/{id}/research", 201, research,
        {"idempotency_key": "loupe:r:f-fixture-spec:00000000-0000-4000-8000-000000000001",
         "run_id": "00000000-0000-4000-8000-000000000001", "change": "save", "expected_version": 2})
    add("research-status", "GET", "/v1/topics/{id}/research", 200,
        envelope({"spec": tid, "topic": "e:topic:fixture", "state": "queued",
                  "run": {"id": run, "status": "queued", "opened_at": "2026-11-05T00:00:00Z"},
                  "engines": [], "cost": None, "reported": False,
                  "results": {"accepted_claims": 0, "edges": 0, "needs_review": 0, "since": "2026-11-05T00:00:00Z",
                              "list_url": "/v1/nodes/e:topic:fixture/edges?direction=in&rtypes=IN_TOPIC",
                              "review_url": "/v1/nodes/e:topic:fixture/edges?direction=in&rtypes=IN_TOPIC&include_unverified=true"},
                  "discovery": "narrowed", "discovery_reason": "private_topic_registered_sources_only",
                  "pending_hosts": 0, "failures": []}))
    packet["errors"] = [problem(code, **({"stored": False, "hits": [hit]} if code == "secret_detected" else {}))
                        for code in spec["x-first-party-errors"]]
    packet["dry_run"] = {"would_reject": True, "hits": [hit], "secret_rules": ready["secret_rules"]}
    packet["spooled"] = dict(base, version=None, seq=None, projected=False, spooled=True,
                             write_ref="w-fixture", reason="gate_timeout")
    return packet


def reviewer_packet() -> dict:
    """FW9 normative examples, separate from live replay until implementation aligns.

    The OpenAPI operation extensions are the fixture source, not the checked-in
    generated packet. No WebAuthn, server, UID or provider operation is invoked.
    """
    import copy
    from datetime import datetime, timezone

    def json_value(value):
        # PyYAML resolves unquoted RFC 3339 examples to datetime objects.
        if isinstance(value, datetime):
            if value.tzinfo is None:
                raise ValueError("Contract timestamps require a timezone")
            return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if isinstance(value, dict):
            return {key: json_value(nested) for key, nested in value.items()}
        if isinstance(value, list):
            return [json_value(nested) for nested in value]
        return value

    spec = yaml.safe_load((R.REPO / "docs/contracts/openapi.yaml").read_text(encoding="utf-8"))
    cases = []
    for item in spec["paths"].values():
        for method, operation in item.items():
            if method not in ("get", "post", "put", "delete", "patch", "head", "options", "trace"):
                continue
            cases.extend(json_value(copy.deepcopy(operation.get("x-contract-cases", []))))
    return {"synthetic": True, "contract_version": CONTRACT_VERSION,
            "note": "합성 계약 예시. 실제 WebAuthn/외부 전송/HTTP 실행 결과가 아니다.", "cases": cases}


def generate(workdir: Path) -> dict[str, bytes]:
    """workdir 아래 임시 KB_HOME 둘을 쓰고 {상대경로: 바이트}를 돌려준다."""
    files: dict[str, bytes] = {}
    held = held_fixture(workdir / "held-home")
    home = workdir / "home"
    (home / "config").mkdir(parents=True)
    old = {k: os.environ.get(k) for k in ("KB_HOME", "KB_CONFIG_DIR", "KB_SHARE")}
    os.environ["KB_HOME"], os.environ["KB_CONFIG_DIR"] = str(home), str(home / "config")
    os.environ.pop("KB_SHARE", None)
    try:
        w = W.build()
        files["ledger.ndjson"] = W.ledger_lines(w)
        for sha, data in w.cas.items():
            files[f"cas/{sha}"] = data
        rp = R.Replayed(home, w.ev, w.cas, w.exported_after, W.NOW_MS)
        try:
            app = R.build_app(rp.path)
            rec = Recorder(app)
            with R.fixed_clock(W.NOW_MS), R.fake_registry():
                define_cases(rec, rp)
            head = {"synthetic": True, "contract_version": CONTRACT_VERSION, "now_ms": W.NOW_MS, "export_after_seq": w.exported_after,
                    "ledger_events": len(w.ev), "tags": TAGS}
        finally:
            rp.close()
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    banner = ("# 합성 데이터다. 실제 사실이 아니다. tests/contract/gen_fixtures.py가 만든다. 손으로 고치지 않는다.\n"
              "# 사례 하나가 요청 하나다. 응답은 responses/<id>.json이다.\n")
    files["requests.yaml"] = (banner + yaml.safe_dump({"meta": head, "cases": rec.cases}, allow_unicode=True, sort_keys=False, width=200)).encode()
    for cid, st in rec.res.items():
        files[f"responses/{cid}.json"] = R.dump_json(st).encode()
    files["mcp/kb_put-held.json"] = R.dump_json(held).encode()
    packet = first_party_packet()
    files["first-party.json"] = R.dump_json(packet).encode()
    for case in packet["cases"]:
        files[f"first-party/responses/{case['id']}.json"] = R.dump_json(case).encode()
    reviewer = reviewer_packet()
    files["reviewer.json"] = R.dump_json(reviewer).encode()
    for case in reviewer["cases"]:
        files[f"reviewer/responses/{case['id']}.json"] = R.dump_json(case).encode()
    return files


def write_fixtures(files: dict[str, bytes], dest: Path) -> None:
    # 생성 대상만 덮어쓴다. 사용자·동료의 기존 파일은 삭제하지 않는다.
    for rel, data in files.items():
        p = dest / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


def diff_fixtures(files: dict[str, bytes], dest: Path) -> list[str]:
    out = []
    disk = {str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file() and p.name != "README.md"}
    for rel in sorted(set(files) | disk):
        if rel not in files:
            out.append(f"디스크에만 있음: {rel}")
        elif rel not in disk:
            out.append(f"디스크에 없음: {rel}")
        elif (dest / rel).read_bytes() != files[rel]:
            out.append(f"다름: {rel}")
    return out


def main(argv: list[str]) -> int:
    mode = "--check" if "--check" in argv else "--write"
    base = Path(os.environ.get("KB_TMP") or os.environ.get("KB_HOME") or Path.home() / ".cache/sagae-kb/build")
    if str(base).startswith("/tmp"):
        print("임시 폴더는 디스크에 둔다(KB_TMP).", file=sys.stderr)
        return 2
    base.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="cfx-", dir=base))
    try:
        files = generate(work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if mode == "--check":
        d = diff_fixtures(files, R.FIX)
        print("\n".join(d) if d else f"fixture 일치: {len(files)}개 파일")
        return 1 if d else 0
    write_fixtures(files, R.FIX)
    print(f"fixture 기록: {len(files)}개 파일 -> {R.FIX}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
