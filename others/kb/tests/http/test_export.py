"""스냅샷 export 게시(계약 5장): 필터, 전송 바이트 sha256, 게시 중 읽기, 증분 이어받기."""
import hashlib
import json
import threading
from compression import zstd

import pytest
from jsonschema import Draft202012Validator

from httphelp import E, claim, entity, hdr, record, snap
from kb import publish
from openapi_check import DOC


def _file(client, profile):
    r = client.get(f"/v1/export/graph?profile={profile}")
    assert r.status == 200
    return r, json.loads(zstd.decompress(r.body))


def _validate_file(obj):
    sch = {"$ref": "#/components/schemas/ExportFile", "components": DOC["components"]}
    errs = list(Draft202012Validator(sch).iter_errors(obj))
    assert not errs, errs[0].message


def _more(world):
    world.add(claim("c-fact", "e:feature:history", "history는 도구 X를 쓴다", predicate="supported_by", object="e:tool:x"),
              claim("c-unv", "e:feature:history", "둘째 문단입니다.", verification="needs_review", predicate="supported_by",
                    object="e:product:p"),
              claim("c-unv2", "e:feature:history", "history 기능은 위젯을 지원한다", verification="unverified",
                    predicate="supported_by2", object="e:tool:x"),
              entity("e:tool:old", "옛 도구"), entity("e:tool:new", "새 도구"),
              E("edge.put", {"id": "r-old", "src": "e:tool:old", "rtype": "USES", "dst": "e:product:p"}),
              E("entity.merge", {"from": "e:tool:old", "into": "e:tool:new"}))


def test_not_ready_before_first_publish(client):
    for t in ("/v1/export/graph/manifest", "/v1/export/graph?profile=core", "/v1/export/graph?profile=full"):
        r = client.get(t)
        assert r.status == 503 and json.loads(r.body)["code"] == "not_ready" and int(hdr(r, "retry-after")) >= 1


def test_transport_bytes_sha_and_content_type(world, client):
    _more(world)
    res = publish.publish(db_path=world.path)
    assert res["published"] and res["build_id"] == f"p-{int(json.loads(client.get('/v1/meta').body)['applied_seq']):09d}"
    man = json.loads(client.get("/v1/export/graph/manifest").body)["data"]
    for prof in ("core", "full"):
        r, obj = _file(client, prof)
        assert hdr(r, "content-type") == "application/zstd" and hdr(r, "content-encoding") is None
        pr = man["profiles"][prof]
        assert hashlib.sha256(r.body).hexdigest() == pr["sha256"] and len(r.body) == pr["bytes"]
        assert (len(obj["nodes"]["rows"]), len(obj["edges"]["rows"])) == (pr["nodes"], pr["edges"])
        assert pr["path"] == f"/v1/export/graph?profile={prof}"
        _validate_file(obj)
        assert obj["build_id"] == man["build_id"] and obj["applied_seq"] == man["applied_seq"]
        assert obj["graph"] == {"directed": True, "multi": True}
        assert obj["nodes"]["columns"] == ["id", "type", "label", "origin", "status", "domain", "merged_into"]
        assert obj["edges"]["columns"] == ["id", "src", "dst", "rtype", "status"]
    assert man["build_id"].startswith("p-") and len(man["build_id"]) == 11 and man["changes_cursor"]


def test_no_private_or_secret_and_filters(world, client):
    _more(world)
    publish.publish(db_path=world.path)
    for prof in ("core", "full"):
        r, obj = _file(client, prof)
        raw = zstd.decompress(r.body).decode()
        for bad in ("f-priv", "f-sec", "SECRET-BODY", "private 본문", "비공개 메모", "비밀 메모"):
            assert bad not in raw, (prof, bad)
        nodes = {row[0]: row for row in obj["nodes"]["rows"]}
        ids = set(nodes)
        assert all(e[1] in ids and e[2] in ids for e in obj["edges"]["rows"]), "허공 엣지"
        assert all(isinstance(row[5], list) for row in obj["nodes"]["rows"])      # domain 셀은 배열
        # unverified, needs_review 주장의 사실 투영 엣지 0
        assert not any(e[3] in ("supported_by2",) for e in obj["edges"]["rows"])
        assert not [e for e in obj["edges"]["rows"] if e[3] == "supported_by" and e[2] == "e:product:p"]
        assert "c-unv" not in ids and "c-unv2" not in ids
    core = {row[0]: row for row in _file(client, "core")[1]["nodes"]["rows"]}
    full = _file(client, "full")[1]
    fullnodes = {row[0]: row for row in full["nodes"]["rows"]}
    assert "c-1" not in core and "n-1" not in core                  # Claim, Snapshot은 core에 없다
    assert "c-1" in fullnodes and "n-1" in fullnodes
    assert "s:rank" in core and core["s:rank"][1] == "Series"       # Series 타입은 core에 있다
    assert "f-1" in core and "e:product:p" in core


def test_core_series_measures_and_fact_edges_and_status_column(world, client):
    _more(world)
    publish.publish(db_path=world.path)
    core = _file(client, "core")[1]
    rt = {e[3] for e in core["edges"]["rows"]}
    assert "MEASURES" in rt and "supported_by" in rt and {"PART_OF", "USES"} <= rt
    assert all(e[4] == "active" for e in core["edges"]["rows"]) and all(n[4] == "active" for n in core["nodes"]["rows"])
    full = _file(client, "full")[1]
    assert {e[4] for e in full["edges"]["rows"]} >= {"active"}


def test_merged_nodes(world, client):
    _more(world)
    publish.publish(db_path=world.path)
    core = _file(client, "core")[1]
    ids = {n[0] for n in core["nodes"]["rows"]}
    assert "e:tool:old" not in ids and "e:tool:new" in ids                # core는 병합 노드를 뺀다
    r_old = [e for e in core["edges"]["rows"] if e[0] == "r-old"]
    assert r_old and r_old[0][1] == "e:tool:new"                           # 끝점을 병합 대상으로 바꾼다
    full = _file(client, "full")[1]
    old = [n for n in full["nodes"]["rows"] if n[0] == "e:tool:old"]
    assert old and old[0][6] == "e:tool:new"                               # full은 merged_into 컬럼과 함께 포함
    assert any(e[0] == "r-old" and e[1] == "e:tool:old" for e in full["edges"]["rows"])


def test_unchanged_and_min_interval(world):
    a = publish.publish(db_path=world.path, now_ms=1_800_000_000_000)
    assert a["published"]
    assert publish.publish(db_path=world.path, now_ms=1_800_000_900_000) == {"published": False, "reason": "unchanged", "build_id": a["build_id"]}
    world.add(entity("e:tool:z", "Z"))
    b = publish.publish(db_path=world.path, now_ms=1_800_000_060_000)           # 변경이 있어도 5분 안
    assert b["reason"] == "min_interval"
    c = publish.publish(db_path=world.path, now_ms=1_800_000_301_000)
    assert c["published"] and c["build_id"] != a["build_id"]
    assert publish.current().manifest["build_id"] == c["build_id"]
    assert publish.publish(db_path=world.path, force=True, now_ms=1_800_000_302_000)["published"]


def test_no_reads_fail_while_publishing(world, client):
    publish.publish(db_path=world.path, force=True)
    shas, stop, errors = {publish.current().manifest["profiles"]["core"]["sha256"]}, threading.Event(), []

    def reader():
        while not stop.is_set():
            for t in ("/v1/export/graph/manifest", "/v1/export/graph?profile=core", "/v1/export/graph?profile=full"):
                r = client.get(t)
                if r.status != 200:
                    errors.append((t, r.status))
                elif "graph?" in t:
                    try:
                        zstd.decompress(r.body)
                    except Exception as e:      # noqa: BLE001
                        errors.append((t, repr(e)))
    ths = [threading.Thread(target=reader) for _ in range(3)]
    for t in ths:
        t.start()
    try:
        for i in range(8):
            world.add(entity(f"e:tool:p{i}", f"P{i}"))
            r = publish.publish(db_path=world.path, force=True)
            shas.add(r["profiles"]["core"]["sha256"])
    finally:
        stop.set()
        for t in ths:
            t.join()
    assert errors == []


def test_changes_cursor_continues(world, client):
    publish.publish(db_path=world.path, force=True)
    man = json.loads(client.get("/v1/export/graph/manifest").body)["data"]
    world.add(entity("e:tool:after", "공개 후"), record("f-after", "나중 메모"))
    d = json.loads(client.get("/v1/changes?cursor=" + man["changes_cursor"]).body)
    ids = [i["id"] for i in d["data"]["items"]]
    assert "e:tool:after" in ids and "f-after" in ids and not [i for i in d["data"]["items"] if i["seq"] <= man["applied_seq"]]
    r, obj = _file(client, "core")
    assert "e:tool:after" not in {n[0] for n in obj["nodes"]["rows"]}


def test_tick_stage_and_cli(world, kb_home, capsys):
    from kb.cli import main
    from kb.publish import tick_stage
    assert tick_stage.STAGES[0][:2] == (6.2, "publish")
    assert main(["publish", "--force", "--json", "--db", str(world.path)]) == 0
    assert json.loads(capsys.readouterr().out)["published"] is True


def test_tick_discovers_publish_stage_and_internal_job():
    from kb.collect import internal
    from kb.collect.tick import discover_stages
    found, failed = discover_stages()
    assert (6.2, "publish") in found and (6.2, "publish") not in failed
    assert any(j["id"] == "publish.prune" and float(j["stage"]) == 6.2 for j in internal.load_jobs())


def test_tick_stage_not_ready_is_not_failure(kb_home):
    from kb.publish import tick_stage
    r = tick_stage.run()          # gold가 없는 새 KB_HOME
    assert r.ok and r.detail.get("published") is False
