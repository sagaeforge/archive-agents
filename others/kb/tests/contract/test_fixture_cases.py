"""fixture 사례 목록(계약 9장): 사례가 빠짐없이 있고 이름이 가리키는 내용이 응답에 실제로 있다.

26개 경로마다 성공 1건과 오류 1건, openapi.yaml의 examples ID, 304, Cache-Control 구분, as_of_unsupported,
truncated=true, total=null 포함. 디스크 파일만 읽는다.
"""
import base64
import json
import re
from pathlib import Path

import pytest
import yaml

import cfx_run as R

OPENAPI = yaml.safe_load((R.REPO / "docs/contracts/openapi.yaml").read_text(encoding="utf-8"))

# 계약 9장 표(+ 인수 조건)에 이름이 오른 사례. 태그가 하나라도 빠지면 실패한다.
REQUIRED = {
    "supersede_chain", "retroactive_correction", "future_effective", "dead_subject", "superseded_subject", "revived", "merge_chain",
    "sensitivity_raise", "korean_text", "emoji_offset", "nfd_input", "hidden", "parallel_edges", "empty_search", "cursor_mismatch",
    "epoch_changed", "export_follow", "series_reannounce", "series_gap", "first_party", "held", "unknown_param", "filter_syntax",
    "ids_param", "node_id_kinds", "search_kinds", "not_modified", "cache_control", "as_of_unsupported", "truncated", "total_null",
    "tail_cursor", "overview_cursor", "sort_desc_tie",
}


def _body(stored, cid):
    return stored(cid).get("body")


def _find_true(o, key):
    if isinstance(o, dict):
        return any((k == key and v is True) or _find_true(v, key) for k, v in o.items())
    if isinstance(o, list):
        return any(_find_true(x, key) for x in o)
    return False


def _templates():
    return list(OPENAPI["paths"])


def _template_of(path_only: str) -> str:
    for t in _templates():
        rx = "^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(t)) + "$"
        if re.match(rx, path_only):
            return t
    raise AssertionError(f"계약에 없는 경로: {path_only}")


def _cases_by_tag(doc):
    out = {}
    for c in doc["cases"]:
        for t in c.get("tags", []):
            out.setdefault(t, []).append(c)
    return out


def test_tags_declared_and_all_required_present(requests_doc):
    declared = set(requests_doc["meta"]["tags"])
    assert REQUIRED <= declared, REQUIRED - declared
    by = _cases_by_tag(requests_doc)
    held = (R.FIX / "mcp" / "kb_put-held.json").exists()
    missing = sorted(t for t in REQUIRED if t not in by and not (t == "held" and held))
    assert not missing, f"사례가 없는 태그: {missing}"
    for c in requests_doc["cases"]:
        for t in c.get("tags", []):
            assert t in declared, (c["id"], t)


def test_every_path_has_a_success_and_an_error_case(requests_doc):
    seen = {t: {"ok": [], "err": []} for t in _templates()}
    assert len(seen) == 35  # Derived from openapi.yaml 0.5.0 paths.
    for c in requests_doc["cases"]:
        t = _template_of(c["path"].split("?")[0])
        if c.get("method", "GET").lower() not in OPENAPI["paths"][t] or c.get("headers", {}).get("Host"):
            continue
        if 200 <= c["status"] < 300:
            seen[t]["ok"].append(c["id"])
        elif 400 <= c["status"] < 500:
            seen[t]["err"].append(c["id"])
    for c in json.loads((R.FIX / "reviewer.json").read_text(encoding="utf-8"))["cases"]:
        t = c["path_template"]
        if c["method"].lower() not in OPENAPI["paths"][t]:
            continue
        if 200 <= c["status"] < 300:
            seen[t]["ok"].append(c["id"])
        elif 400 <= c["status"] < 500:
            seen[t]["err"].append(c["id"])
    lacking = {t: v for t, v in seen.items() if not v["ok"] or not v["err"]}
    assert not lacking, lacking


def test_openapi_example_ids_are_in_fixtures(requests_doc):
    want = set()
    for t, item in OPENAPI["paths"].items():
        for code, resp in ((code, resp) for method, operation in item.items() if method in ("get", "post", "put", "patch", "delete", "head", "options", "trace") for code, resp in operation["responses"].items()):
            if "$ref" in resp:
                continue
            for ctype, media in resp.get("content", {}).items():
                for ex in (media.get("examples") or {}):
                    want.add((t, int(code), ex))
    assert len(want) >= 26
    have = set()
    for c in requests_doc["cases"]:
        for ex in c.get("examples", []):
            have.add((_template_of(c["path"].split("?")[0]), c["status"], ex))
    for c in json.loads((R.FIX / "reviewer.json").read_text(encoding="utf-8"))["cases"]:
        t = c["path_template"]
        resp = OPENAPI["paths"][t][c["method"].lower()]["responses"][str(c["status"])]
        for media in resp.get("content", {}).values():
            for ex, example in (media.get("examples") or {}).items():
                if example.get("value") == c["response"]:
                    have.add((t, c["status"], ex))
    assert want <= have, sorted(want - have)


def test_each_tag_means_what_it_says(requests_doc, stored):
    by = _cases_by_tag(requests_doc)

    def st(c):
        return stored(c["id"])

    for c in by["not_modified"]:
        s = st(c)
        assert s["status"] == 304 and s["headers"].get("etag") and s.get("body") is None, c["id"]
        assert c["headers"]["If-None-Match"].startswith('"'), c["id"]
    for c in by["unknown_param"]:
        assert st(c)["status"] == 400 and st(c)["body"]["code"] == "bad_param", c["id"]
    for c in by["as_of_unsupported"]:
        assert st(c)["status"] == 400 and st(c)["body"]["code"] == "as_of_unsupported", c["id"]
    for c in by["cursor_mismatch"]:
        assert st(c)["status"] == 400 and st(c)["body"]["code"] == "cursor_mismatch", c["id"]
    for c in by["epoch_changed"]:
        assert st(c)["status"] == 410 and st(c)["body"]["code"] == "epoch_changed", c["id"]
    assert any(_find_true(st(c)["body"], "truncated") for c in by["truncated"])
    for c in by["truncated"]:
        assert _find_true(st(c)["body"], "truncated"), c["id"]
    for c in by["total_null"]:
        assert st(c)["body"]["page"]["total"] is None, c["id"]
    # Cache-Control: 경로 구분마다 값이 다르다
    ccs = {st(c)["headers"].get("cache-control") for c in requests_doc["cases"] if st(c)["status"] == 200}
    assert {"no-cache", "no-store"} <= ccs, ccs
    # 숨김: 직접 조회는 404, ids= 는 응답에서 빠진다
    for c in by["hidden"]:
        s = st(c)
        if c["path"].startswith("/v1/nodes?ids="):
            assert {i["id"] for i in s["body"]["data"]["items"]}.isdisjoint({"f-priv", "f-sec"})
        else:
            assert s["status"] == 404, c["id"]
    # 민감도 상향: 피드에 본문 없는 visibility.revoked
    rev = [x for c in by["sensitivity_raise"] if c["path"].startswith("/v1/changes")
           for x in st(c)["body"]["data"]["items"] if x["kind"] == "visibility.revoked"]
    assert rev and all(set(x) == {"seq", "at", "kind", "id"} for x in rev)
    # 빈 검색
    assert all(st(c)["body"]["data"]["items"] == [] for c in by["empty_search"])
    # 검색 kind 네 종류
    kinds = {i["kind"] for c in by["search_kinds"] for i in st(c)["body"]["data"]["items"]}
    assert kinds == {"claim", "record", "entity", "passage"}
    # 평행 엣지: 같은 양끝, 다른 관계
    pe = [x for c in by["parallel_edges"] if c["id"] == "edges-parallel" for x in st(c)["body"]["data"]["items"]]
    assert len(pe) == 2 and len({(e["src"], e["dst"]) for e in pe}) == 1 and len({e["rtype"] for e in pe}) == 2
    # 노드 ID 종류: 9종 모두 없는 ID는 404
    miss = [c for c in by["node_id_kinds"] if c["id"].endswith("-missing")]
    assert len(miss) == 9 and all(st(c)["status"] == 404 for c in miss)
    # 병합: 연쇄의 최종 대상과 옛 id 조회
    old = stored("node-merged-old")["body"]["data"]
    assert old["merged_into"] == "e:tool:mb" and old["merged_into_final"] == "e:tool:mc" and old["status"] == "superseded"
    # 대체 체인 3세대
    chain = {i["id"]: i["status"] for i in stored("claims-chain-all")["body"]["data"]["items"] if i["id"].startswith("c-chain")}
    assert chain == {"c-chain-1": "superseded", "c-chain-2": "superseded", "c-chain-3": "active"}
    # 미래 발효: 효력일 전 두 주장 active, as_of_valid로 값 하나
    both = stored("claims-future-both-active")["body"]["data"]["items"]
    assert {i["id"]: i["status"] for i in both} == {"c-fut-old": "active", "c-fut-new": "active"}
    assert [i["id"] for i in stored("claims-future-before")["body"]["data"]["items"]] == ["c-fut-old"]
    assert [i["id"] for i in stored("claims-future-after")["body"]["data"]["items"]] == ["c-fut-new"]
    # 소급 정정: 같은 유효 시점, 관측 시점에 따라 값이 어긋난다
    b = stored("claims-retro-observed-before")["body"]["data"]["items"][0]
    a = stored("claims-retro-observed-after")["body"]["data"]["items"][0]
    assert (b["value"], a["value"]) == ("4000", "3000")
    # dead 주어: state는 status가 바뀌고 event는 유지된다. 판정 전 as-of는 둘 다 active
    assert [i["id"] for i in stored("claims-dead-default")["body"]["data"]["items"]] == ["c-dead-event"]
    dead = stored("claims-dead-status")["body"]["data"]["items"]
    assert [(i["id"], i["status"], i["own_status"]) for i in dead] == [("c-dead-state", "dead", "active")]
    assert {i["id"] for i in stored("claims-dead-observed-before")["body"]["data"]["items"]} == {"c-dead-event", "c-dead-state"}
    sup = stored("claims-superseded-subject")["body"]["data"]["items"]
    assert [(i["id"], i["status"]) for i in sup] == [("c-old-state", "superseded")]
    # 번복
    assert [v["status"] for v in stored("history-revived")["body"]["data"]["versions"]] == ["active", "dead", "active"]
    # 시계열: 재공시된 d2, 공백 구간
    ser = stored("series-ok")["body"]["data"]
    assert {p["period"]: p["value"] for p in ser["points"]}["d2"] == "2" and ser["gaps"]
    assert {p["period"]: p["value"] for p in stored("series-observed-before-reannounce")["body"]["data"]["points"]}["d2"] == "4"
    # first_party: Markdown, 작성자, 버전, 백링크
    fp = stored("node-first-party")["body"]["data"]
    assert fp["body_format"] == "markdown" and fp["author"] == "user:sagae" and fp["version"] == 2
    ag = stored("node-agent-record")["body"]["data"]
    assert ag["author"].startswith("agent:") and ag["on_behalf_of"] == "user:sagae"
    assert [x["id"] for x in stored("node-backlinks")["body"]["data"]["backlinks"]] == ["f-1"]
    held = json.loads((R.FIX / "mcp" / "kb_put-held.json").read_text(encoding="utf-8"))
    assert held["response"]["held"] is True and held["response"]["seq"] is None
    # export 뒤 이어 받기, 꼬리의 문자열 커서
    ids = [x["id"] for x in stored("changes-after-export")["body"]["data"]["items"]]
    assert ids == ["e:tool:tail", "c-tail", "f-tail"]
    tail = stored("changes-tail")["body"]
    assert tail["data"]["items"] == [] and isinstance(tail["page"]["next_cursor"], str)
    # 개요 커서: 다음 쪽이 첫 쪽과 겹치지 않는다
    p1 = {r[0] for r in stored("overview-page1")["body"]["data"]["nodes"]["rows"]}
    p2 = {r[0] for r in stored("overview-page2")["body"]["data"]["nodes"]["rows"]}
    assert p1 and p2 and not (p1 & p2)
    # sort 내림차순과 동률: stars가 같은 b, e, f는 id 오름차순
    order = [i["id"].split(":")[-1] for i in stored("nodes-repo-sort-desc")["body"]["data"]["items"]]
    assert order[:2] == ["c", "a"] and order[2:5] == ["b", "e", "f"]
    # filter 문법
    assert [i["id"] for i in stored("nodes-filter-colon")["body"]["data"]["items"]] == ["e:repo:c"]
    # nodes.py:463-480은 label 문자열 열에서 prefix 범위 검색을 지원한다.
    assert [i["id"] for i in stored("nodes-label-prefix")["body"]["data"]["items"]] == ["e:repo:c"]
    assert [i["id"] for i in stored("nodes-filter-in-escape")["body"]["data"]["items"]] == ["e:repo:d", "e:repo:g"]
    assert [i["id"] for i in stored("nodes-filter-and")["body"]["data"]["items"]] == ["e:repo:a"]


def test_quote_offsets_use_codepoints_and_exact_matches(stored):
    """이모지 뒤 인용: 코드포인트 오프셋으로 자르면 exact가 나오고 UTF-16 오프셋과는 다르다. NFD도 같다."""
    for cid, tid in (("node-claim-evidence-emoji", "text-emoji"), ("node-claim-evidence-nfd", "text-nfd")):
        ev = stored(cid)["body"]["data"]["evidence"][0]
        text = stored(tid)["body"]["data"]["text"]
        assert text[ev["start"]:ev["end"]] == ev["exact"], cid
    ev = stored("node-claim-evidence-emoji")["body"]["data"]["evidence"][0]
    text = stored("text-emoji")["body"]["data"]["text"]
    u16 = len(text[:ev["start"]].encode("utf-16-le")) // 2
    assert u16 != ev["start"]
    nfd = stored("node-claim-evidence-nfd")["body"]["data"]["evidence"][0]["exact"]
    import unicodedata
    assert nfd != unicodedata.normalize("NFC", nfd) and unicodedata.is_normalized("NFD", nfd)


def test_korean_cases_find_their_text(stored):
    """조사 붙은 질의, 한 음절 단어, 숫자 표기(쉼표 유무)가 같은 문서를 찾는다."""
    ids = lambda cid: {i["id"] for i in stored(cid)["body"]["data"]["items"]}
    assert ids("search-josa") == ids("search-ok")
    assert "c-ko-2" in ids("search-one-syllable")
    assert ids("search-number") == ids("search-number-comma") and "c-ko-3" in ids("search-number")


def test_export_response_is_zstd_and_matches_manifest(stored):
    from compression import zstd
    man = stored("export-manifest-ok")["body"]["data"]
    for prof in ("core", "full"):
        s = stored(f"export-{prof}")
        raw = base64.b64decode(s["body_base64"])
        assert s["headers"]["content-type"] == "application/zstd"
        import hashlib
        assert hashlib.sha256(raw).hexdigest() == man["profiles"][prof]["sha256"] and len(raw) == man["profiles"][prof]["bytes"]
        text = zstd.decompress(raw).decode("utf-8")
        assert text.strip(), prof


def test_held_fixture_is_not_in_the_ledger():
    held = json.loads((R.FIX / "mcp" / "kb_put-held.json").read_text(encoding="utf-8"))
    ledger_text = (R.FIX / "ledger.ndjson").read_text(encoding="utf-8")
    assert held["response"]["id"] not in ledger_text and "fixture-held-1" not in ledger_text


def test_files_say_they_are_synthetic():
    assert "합성 데이터" in (R.FIX / "requests.yaml").read_text(encoding="utf-8")[:300]
    assert "합성" in (R.FIX / "README.md").read_text(encoding="utf-8")[:400]
    assert yaml.safe_load((R.FIX / "requests.yaml").read_text(encoding="utf-8"))["meta"]["synthetic"] is True
    held = json.loads((R.FIX / "mcp" / "kb_put-held.json").read_text(encoding="utf-8"))
    assert "합성" in held["note"]


@pytest.mark.parametrize("name", ["ledger.ndjson", "requests.yaml"])
def test_fixture_files_exist(name):
    assert (R.FIX / name).stat().st_size > 0


def _response_def(template, status):
    resp = OPENAPI["paths"][template]["get"]["responses"][str(status)]
    if "$ref" in resp:
        resp = OPENAPI["components"]["responses"][resp["$ref"].rsplit("/", 1)[1]]
    return resp


def test_every_stored_response_validates_against_openapi(requests_doc, stored):
    """저장된 응답(실제 데이터가 든 200 포함)이 openapi.yaml의 해당 경로, 상태 코드 응답 스키마를 통과한다."""
    from jsonschema import Draft202012Validator
    checked, errs = 0, []
    for c in requests_doc["cases"]:
        if c.get("method", "GET") != "GET" or c["status"] in (403, 405):
            continue  # 405, 403은 경로 밖 계층의 응답이다
        tpl = _template_of(c["path"].split("?")[0])
        s = stored(c["id"])
        resp = _response_def(tpl, s["status"])
        if s["status"] == 304:
            assert s.get("body") is None
            continue
        ctype = s["headers"]["content-type"].split(";")[0]
        media = resp["content"].get(ctype)
        if media is None and tpl.endswith("/raw") and s["status"] in (200, 206):
            # 계약 설명은 "원 Content-Type 그대로"인데 content에는 application/octet-stream만 선언돼 있다. 틈은 README에 적었다.
            media = resp["content"]["application/octet-stream"]
        assert media is not None, (c["id"], ctype, list(resp.get("content", {})))
        if "body_base64" in s:
            assert media["schema"].get("format") == "binary" or media["schema"].get("type") == "string", c["id"]
            checked += 1
            continue
        sch = dict(media["schema"])
        sch["components"] = OPENAPI["components"]
        e = sorted(Draft202012Validator(sch).iter_errors(s["body"]), key=lambda x: list(x.path))
        if e:
            errs.append(f'{c["id"]}: {list(e[0].path)}: {e[0].message[:160]}')
        checked += 1
    assert not errs, errs[:8]
    assert checked > 150
