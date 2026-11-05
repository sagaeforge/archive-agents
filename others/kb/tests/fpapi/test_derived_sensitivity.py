"""FW5: 파생 주장/복사 근거/관계/색인은 모든 현재 first_party 원본을 따른다."""
import json

import pytest

from test_http_write import api, data, problem  # noqa: F401
from test_write_core import core  # noqa: F401
from read.rhelp import E, T0, claim, entity, record
from kb import read
from kb.core import ledger
from kb.guard.export_md import export_markdown
from kb.project import create_gold, project_tail
from kb.project.build import replay
from kb.project.fingerprint import fingerprint_conn
from kb.read.search import search_in

MARKER = "FW5DERIVEDNEEDLE"
INTERNAL_MARKER = "FW5INDEPENDENTNEEDLE"
CID = "c-fw5-derived"
ORIGINALS = ("f-fw5-source-a", "f-fw5-source-b")
SUBJECT, OBJECT = "e:tool:fw5-subject", "e:tool:fw5-object"


def seed(api, private_source=None, *, sensitive_source=None):
    w = api.world
    sensitive_source = private_source or sensitive_source or ORIGINALS[0]
    w.add(entity(SUBJECT, at=T0), entity(OBJECT, at=T0),
          *[record(rid, "source", "private" if rid == private_source else "internal",
                   body=MARKER if rid == sensitive_source else INTERNAL_MARKER, at=T0) for rid in ORIGINALS],
          claim(CID, SUBJECT, MARKER, at=T0 + 1000, predicate="USES", object=OBJECT,
                evidence=[{"snapshot": rid, "selector_kind": "text_quote",
                           "exact": MARKER if rid == sensitive_source else INTERNAL_MARKER}
                          for rid in ORIGINALS]))


def assert_hidden(w, private_source, **kw):
    with w.rd(**kw) as (con, ctx):
        for fn in (read.get_node, read.get_claim, read.node_body, read.node_edges, read.neighbors):
            with pytest.raises(read.NotFound):
                fn(con, ctx, CID)
        with pytest.raises(read.NotFound):
            read.get_node(con, ctx, private_source)
        outputs = [read.list_nodes(con, ctx, type="Claim"),
                   read.node_claims(con, ctx, SUBJECT),
                   read.get_node(con, ctx, SUBJECT, include="claims,edges,backlinks"),
                   read.neighbors(con, ctx, SUBJECT), read.overview(con, ctx),
                   search_in(con, ctx, MARKER)]
        for output in outputs:
            serialized = json.dumps(output, ensure_ascii=False)
            assert MARKER not in serialized
            if isinstance(output, tuple):
                # changes의 본문 없는 visibility.revoked는 ID를 포함할 수 있다.
                items = output[0].get("items", [])
                assert not [x for x in items if x.get("id") == CID
                            and x.get("kind") != "visibility.revoked"]
        independent = search_in(con, ctx, INTERNAL_MARKER)[0]["items"]
        other = next(rid for rid in ORIGINALS if rid != private_source)
        assert any(x["id"] == other and INTERNAL_MARKER in x["snippet"] for x in independent)
        if kw:
            with pytest.raises(read.AsOfUnsupported):
                read.history(con, ctx, CID)
            with pytest.raises(read.AsOfUnsupported):
                read.changes(con, ctx)
    with w.rd() as (con, ctx):
        with pytest.raises(read.NotFound):
            read.history(con, ctx, CID)
        changes = read.changes(con, ctx)[0]["items"]
        assert MARKER not in json.dumps(changes)
        assert not [x for x in changes if x.get("id") == CID and x["kind"] != "visibility.revoked"]


@pytest.mark.parametrize("private_source", ORIGINALS)
def test_any_private_original_hides_claim_evidence_relation_and_index(api, private_source):
    seed(api, private_source)
    assert_hidden(api.world, private_source)
    with api.world.rd(max_sensitivity="private") as (con, ctx):
        result = read.get_claim(con, ctx, CID)
        assert MARKER in json.dumps(result)
    assert api.world.gold.execute("SELECT sensitivity FROM head WHERE id=?", (CID,)).fetchone()[0] == 2


@pytest.mark.parametrize("raised_source", ORIGINALS)
def test_raise_blocks_stale_projection_then_replay_restart_and_old_time(api, monkeypatch, raised_source):
    seed(api, sensitive_source=raised_source)
    w = api.world
    with w.rd() as (con, ctx):
        assert MARKER in json.dumps(read.get_claim(con, ctx, CID))
    ledger.append(w.led, [record(raised_source, "source", "private", body=MARKER, at=T0 + 3000)])
    # 원장 확정 직후: 아직 gold에 상향을 투영하지 않은 상태도 읽기를 막아야 한다.
    assert_hidden(w, raised_source)
    routes = [f"/v1/nodes/{CID}", f"/v1/nodes/{CID}/body", f"/v1/nodes/{CID}/history",
              f"/v1/nodes/{CID}/edges", f"/v1/nodes/{CID}/neighbors"]
    for projected in (False, True):
        if projected:
            result = project_tail(w.led, w.gold, None, 10 ** 6)
            assert result.caught_up and not result.quarantined
        # API.call의 자동 catch-up을 이 구간에서만 막아 stale HTTP를 실제 검사한다.
        with monkeypatch.context() as patch:
            patch.setattr("test_http_write.project_tail", lambda *a, **k: None)
            for route in routes:
                problem(api.call("GET", route), 404, "not_found")
            for route in ("/v1/nodes?type=Claim", f"/v1/search?q={MARKER}",
                          f"/v1/nodes/{SUBJECT}?include=claims,edges,backlinks", "/v1/changes"):
                response = api.call("GET", route)
                assert response.status == 200, response.body
                assert MARKER.encode() not in response.body
            independent = api.call("GET", f"/v1/search?q={INTERNAL_MARKER}")
            assert independent.status == 200, independent.body
            other = next(rid for rid in ORIGINALS if rid != raised_source)
            assert any(x["id"] == other and INTERNAL_MARKER in x["snippet"]
                       for x in data(independent)["data"]["items"])
        assert_hidden(w, raised_source)
        assert_hidden(w, raised_source, as_of_observed=T0 + 2000)
        api.restart()
        problem(api.call("GET", f"/v1/nodes/{CID}"), 404, "not_found")
        editor = api.call("GET", f"/v1/nodes/{CID}", api.token(f"fw5-{raised_source}-{int(projected)}"))
        assert editor.status == 200 and MARKER.encode() in editor.body
    rebuilt = create_gold(api.home / "scratch" / "fw5-derived-replay.db")
    try:
        _, missing, quarantined = replay(w.led, rebuilt)
        assert not missing and not quarantined
        assert fingerprint_conn(rebuilt) == fingerprint_conn(w.gold)
        ctx = read.ReadCtx.build(db_path=api.home / "scratch" / "fw5-derived-replay.db")
        with read.reading(ctx) as con, pytest.raises(read.NotFound):
            read.get_claim(con, ctx, CID)
    finally:
        rebuilt.close()
    export = export_markdown(commit=False)
    exported = "\n".join(p.read_text() for p in (api.home / "export" / "first_party").rglob("*.md"))
    # 다른 internal 원본 자체는 내보낼 수 있지만 private 원본은 내보내지 않는다.
    assert raised_source not in exported and export["committed"] is False


def test_promoted_from_alone_does_not_downgrade_a_private_source(api):
    api.world.add(record(ORIGINALS[0], "source", "private", body=MARKER),
                  record("f-fw5-copy", "copy", "internal", body=MARKER,
                         links=[{"rtype": "PROMOTED_FROM", "dst": ORIGINALS[0]}]))
    for suffix in ("", "/body", "/history"):
        problem(api.call("GET", "/v1/nodes/f-fw5-copy" + suffix), 404, "not_found")
    with api.world.rd(max_sensitivity="private") as (con, ctx):
        assert read.node_body(con, ctx, "f-fw5-copy")["text"] == MARKER
    export_markdown(commit=False)
    assert not (api.home / "export" / "first_party" / "records" / "f-fw5-copy.md").exists()


@pytest.mark.parametrize("missing_field", ["sensitivity"], ids=["quarantined_event"])
def test_quarantined_malformed_event_does_not_break_reads(api, missing_field):
    seed(api, private_source=ORIGINALS[0])
    w = api.world
    copy_id = "f-fw5-quarantine-copy"
    w.add(record(copy_id, "private-derived copy", "internal", body=MARKER,
                 links=[{"rtype": "PROMOTED_FROM", "dst": ORIGINALS[0]}]))
    malformed = record("f-fw5-malformed", "malformed synthetic record")
    del malformed["payload"][missing_field]
    ledger.append(w.led, [malformed])
    bad_seq = ledger.head(w.led)[0]
    # 격리 전에는 잘못된 확정 이벤트를 조용히 무시하지 않는다.
    with pytest.raises(KeyError, match="sensitivity"):
        with w.rd():
            pass
    projected = project_tail(w.led, w.gold, None, 10 ** 6)
    assert projected.caught_up and bad_seq in projected.quarantined
    assert w.gold.execute("SELECT seq FROM quarantine WHERE seq=?", (bad_seq,)).fetchone() is not None
    assert w.gold.execute("SELECT 1 FROM node WHERE id=?", (malformed["subject"],)).fetchone() is None

    response = api.call("GET", f"/v1/nodes/{ORIGINALS[1]}")
    assert response.status == 200, response.body
    assert data(response)["data"]["id"] == ORIGINALS[1]
    found = api.call("GET", f"/v1/search?q={INTERNAL_MARKER}")
    assert found.status == 200, found.body
    assert any(item["id"] == ORIGINALS[1] and INTERNAL_MARKER in item["snippet"]
               for item in data(found)["data"]["items"])
    for rid in (ORIGINALS[0], CID, copy_id):
        problem(api.call("GET", f"/v1/nodes/{rid}"), 404, "not_found")
    hidden = api.call("GET", f"/v1/search?q={MARKER}")
    assert hidden.status == 200 and MARKER.encode() not in hidden.body
    exported = export_markdown(commit=False)
    assert exported["records"] >= 1 and exported["committed"] is False
    records_dir = api.home / "export" / "first_party" / "records"
    assert (records_dir / f"{ORIGINALS[1]}.md").is_file()
    assert not (records_dir / f"{copy_id}.md").exists()
    assert all(MARKER not in path.read_text() for path in records_dir.glob("*.md"))
