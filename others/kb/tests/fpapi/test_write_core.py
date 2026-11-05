"""FW3 RED 계약. 임시 원장/ops만 쓰며 투영·네트워크·LLM은 실행하지 않는다.

제안 인터페이스: http + token_label/change/on_secret/dry_run 키워드.
WriteRejected.status는 HTTP 매핑용 정수, VersionConflict.current는 구조화 객체다.
"""
import hashlib
import sqlite3

import pytest

from kb.core import ledger, opsdb
from kb.extract import tick_stage
from kb.write import author, engine, record, types
from kb.write.errors import WriteRejected

REC = {"type": "Note", "title": "FW3 합성 메모", "body": "합성 본문", "sensitivity": "internal"}


@pytest.fixture
def core(kb_home, monkeypatch):
    monkeypatch.delenv("KB_LIVE", raising=False)
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    monkeypatch.setenv("KB_CONFIG_DIR", str(kb_home / "config"))
    (kb_home / "config").mkdir()
    monkeypatch.setattr(types, "_CACHE", {"at": 0.0, "dir": None, "val": {}})
    # FW3의 원자성/큐 계약만 검사한다. FW5 투영과 외부 서비스는 범위 밖이다.
    monkeypatch.setattr(engine, "_project", lambda *a, **kw: (True, []))
    c = ledger.open_ledger()
    try:
        ledger.append(c, [{"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system",
                           "subject": "fp", "idem_key": "fw3:open", "payload": {"mode": "drill"}}])
    finally:
        c.close()
    c = opsdb.connect()
    c.close()
    return kb_home


def put(rec=None, key="loupe:c:synthetic", *, label="loupe", change="save", **kw):
    return record.put_record(dict(REC if rec is None else rec), key, "http",
                             token_label=label, change=change, **kw)


def events():
    c = ledger.open_ledger()
    try:
        return ledger.iter_events(c, 0, 10000)
    finally:
        c.close()


def payload(rid):
    return [e["payload"] for e in events() if e["kind"] == "record.put" and e["subject"] == rid][-1]


def snapshot(root):
    """DB의 논리 내용 + 나머지 영속 파일의 해시. WAL/SHM/잠금은 내용 저장소가 아니다."""
    files = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name.endswith(("-wal", "-shm", ".lock")):
            continue
        name = str(p.relative_to(root))
        if p.suffix == ".db":
            c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
            try:
                files[name] = tuple(c.iterdump())
            finally:
                c.close()
        else:
            files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
    return files


def assert_absent(root, *markers):
    # 논리 DB 비교와 별개로 WAL/SHM까지 검사해 롤백된 평문도 잡는다.
    for p in root.rglob("*"):
        if p.is_file():
            data = p.read_bytes()
            assert all(marker.encode("utf-8") not in data for marker in markers), str(p.relative_to(root))


def rejected(call, code, status):
    with pytest.raises(WriteRejected) as exc:
        call()
    assert exc.value.code == code
    assert getattr(exc.value, "status", None) == status
    return exc.value


@pytest.mark.parametrize("change,claimed", [("save", "user:sagae"), ("autosave", "user:sagae"), ("auto", None)])
def test_http_attribution_three_modes(core, change, claimed):
    au = author.resolve("http", token_label="loupe", change=change)
    assert au.actor == "app:loupe" and au.on_behalf_of == claimed
    assert au.generated_by == f"app:loupe:{change}"
    result = put(change=change)
    ev = next(e for e in events() if e["kind"] == "record.put")
    assert (ev["actor"], ev.get("on_behalf_of"), ev.get("generated_by")) == (
        "app:loupe", claimed, f"app:loupe:{change}")
    response = result.as_dict()
    assert (response["actor"], response["claimed_author"], response["generated_by"]) == (
        "app:loupe", claimed, f"app:loupe:{change}")
    for field in ("payload_sha", "unchanged", "quarantined", "write_ref"):
        assert field in response


@pytest.mark.parametrize("field", ["actor", "author", "on_behalf_of", "generated_by"])
def test_client_cannot_supply_attribution(core, field):
    rejected(lambda: put(dict(REC, **{field: "user:sagae"})), "schema_invalid", 400)


@pytest.mark.parametrize("transport,tty,actor,claimed", [
    ("mcp", False, "agent:fw3", "user:sagae"), ("inbox", False, "user:sagae", None),
    ("cli", True, "user:sagae", None), ("cli", False, "agent:cli", None),
])
def test_legacy_attribution_unchanged(transport, tty, actor, claimed):
    au = author.resolve(transport, "fw3", tty=tty)
    assert (au.actor, au.on_behalf_of) == (actor, claimed)


@pytest.mark.parametrize("field,value,code,status", [
    ("body", "가" * ((1024 * 1024) // 3 + 1), "body_too_large", 413),
    ("title", "가" * 301, "schema_invalid", 400),
    ("props", {"memo": "가" * 6000}, "schema_invalid", 400),
    ("links", [{"rtype": "LINKS_TO", "dst": "e:concept:item-" + str(i)} for i in range(501)],
     "schema_invalid", 400),
    ("body", " ".join("[[e:concept:item-" + str(i) + "]]" for i in range(501)), "schema_invalid", 400),
])
def test_editor_size_limits_before_persistence(core, field, value, code, status):
    before = snapshot(core)
    rejected(lambda: put(dict(REC, **{field: value})), code, status)
    assert snapshot(core) == before


@pytest.mark.parametrize("field,value", [("title", "가" * 300), ("body", "x" * (1024 * 1024))])
def test_editor_size_boundary_dry_run(core, field, value):
    before = snapshot(core)
    result = put(dict(REC, **{field: value}), dry_run=True)
    assert result["would_reject"] is False
    assert result["hits"] == []
    assert snapshot(core) == before


def queue_rows():
    c = opsdb.connect()
    try:
        return c.execute("SELECT kind, ref FROM queue ORDER BY kind, ref").fetchall()
    finally:
        c.close()


@pytest.mark.parametrize("typ,change", [("TopicSpec", "save"), ("Review", "save"), ("Page", "auto"), ("Note", "auto")])
def test_extraction_skips_specs_reviews_auto(core, typ, change):
    ev = {"kind": "record.put", "seq": 10, "origin": "first_party", "actor": "app:loupe",
          "generated_by": f"app:loupe:{change}",
          "payload": dict(REC, id="f-" + "a" * 26, type=typ)}
    assert tick_stage._enqueue_record(ev) is False
    assert queue_rows() == []


@pytest.mark.parametrize("typ", ["Page", "Note"])
def test_extraction_merges_versions_to_latest_reference(core, typ):
    rid = "f-" + "a" * 26
    other = "f-" + "b" * 26
    for record_id, seq in [(rid, 10), (other, 11), (rid, 12), (rid, 15), (rid, 12)]:
        tick_stage._enqueue_record({"kind": "record.put", "seq": seq, "origin": "first_party",
                                    "actor": "app:loupe", "generated_by": "app:loupe:save",
                                    "payload": dict(REC, id=record_id, type=typ)})
    assert queue_rows() == [(tick_stage.QUEUE_SENSITIVE, f"{rid}|15"),
                            (tick_stage.QUEUE_SENSITIVE, f"{other}|11")]
