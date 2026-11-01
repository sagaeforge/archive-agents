"""항목 정책: record는 producer=user:*만, event 시점, 생존 근거의 1차 출처, src:adhoc의 공식 위치 규칙,
후속 없는 superseded, 거부 호스트 snapshot, ticket 머리의 ANSWERS 엣지."""
import pytest

from .conftest import capture, gold, res, run

DOC = b"""# Widget Toolkit

The Widget Toolkit stores 5 widgets per page. Widget Toolkit exits with code 0 on success.

Widget Toolkit 3.0 was released on 2026-03-01. The legacy mode is removed.
"""
REC = {"item": "record", "ref": "r1", "title": "메모", "body": "본문", "sensitivity": "internal"}


def ent(ref="e1", key="concept:widget-toolkit", typ="Concept", label="Widget Toolkit", **kw):
    return {"item": "entity", "ref": ref, "key": key, "type": typ, "label": label, **kw}


def claim(snap, quote, statement, ref="c1", **kw):
    d = {"item": "claim", "ref": ref, "subject": "e1", "statement": statement, "kind": "state", "stance": "stated",
         "evidence": {"snapshot": snap, "quote": quote}, "method": "llm"}
    d.update(kw)
    return d


def sig(snap, quote, id_="M01"):
    return [{"id": id_, "snapshot": snap, "quote": quote}]


@pytest.fixture
def doc(env):
    return capture("https://example.org/widget", DOC, source="src:adhoc")


def test_record_only_from_user_bundles(env):
    r = run([REC], producer="agent:kb-collector")
    assert res(r, "r1")["code"] == "E_POLICY"
    r = run([REC], producer="user:sagae")
    assert res(r, "r1")["result"] == "held" and res(r, "r1")["code"] == "H_FP_CLOSED"      # first_party 개방 전
    from kb import ingest
    from .conftest import bundle
    rep = ingest.validate(bundle([REC], producer="user:sagae"), fetch=False, profile="collector")
    assert res(rep, "r1")["code"] == "E_POLICY"                                          # collector 프로필의 record


def test_event_without_time(env, doc):
    r = run([ent(), claim(doc, "stores 5 widgets per page", "Widget Toolkit stores 5 widgets per page.", kind="event")])
    assert res(r, "c1")["code"] == "E_EVENT_TIME"
    r = run([ent(), claim(doc, "3.0 was released on 2026-03-01", "Widget Toolkit 3.0 was released on 2026-03-01.", kind="event",
                           valid={"from": "2026-03-01", "precision": "day"})])
    assert res(r, "c1")["result"] == "accepted"
    r = run([ent(), claim(doc, "3.0 was released on 2026-03-01", "Widget Toolkit 3.0 was released on 2026-03-01.", kind="event",
                           changed_on="2026-03-01")])
    assert res(r, "c1")["result"] == "accepted"


def test_liveness_signal_must_be_primary(env):
    s_sec = capture("https://kworb.net/x", DOC, source="src:kworb")          # trust=secondary
    s_pri = capture("https://code.claude.com/docs/en/w.md", DOC, source="src:cc-docs-en")   # trust=primary
    live = lambda s: {"state": "removed", "unit": "feature", "signals": sig(s, "The legacy mode is removed"), "decided_by": "agent:x"}
    r = run([ent(key="feature:legacy", typ="Feature", label="legacy mode", liveness=live(s_sec))])
    assert res(r, "e1")["code"] == "E_LIVENESS_SOURCE"
    r = run([ent(key="feature:legacy", typ="Feature", label="legacy mode", liveness=live(s_pri))])
    assert res(r, "e1")["result"] == "accepted"


@pytest.mark.parametrize("unit,key,typ,label,props,ok_url,bad_urls", [
    ("repo", "repo:acme-widget", "Repo", "acme/widget", {"repo": "acme/widget"},
     "https://github.com/acme/widget/releases/tag/v1", ["https://github.com/acme/other/releases", "https://gitlab.com/acme/widget",
                                                         "https://example.org/acme/widget"]),
    ("package", "package:widget-pkg", "Package", "widget-pkg", {"package": "widget-pkg"},
     "https://registry.npmjs.org/widget-pkg", ["https://registry.npmjs.org/other-pkg", "https://example.org/widget-pkg"]),
    ("doc", "document:widget-doc", "Document", "Widget doc", {"url": "https://docs.example.org/widget"},
     "https://docs.example.org/widget/changelog", ["https://evil.example.net/widget"]),
])
def test_adhoc_is_primary_only_at_the_official_location(env, unit, key, typ, label, props, ok_url, bad_urls):
    def case(url):
        s = capture(url, DOC, source="src:adhoc")
        lv = {"state": "removed", "unit": unit, "signals": sig(s, "The legacy mode is removed"), "decided_by": "agent:x"}
        return res(run([ent(key=key, typ=typ, label=label, props=props, liveness=lv)]), "e1")
    assert case(ok_url)["result"] == "accepted"
    for u in bad_urls:
        r = case(u)
        assert r["code"] == "E_LIVENESS_SOURCE", (u, r)


def test_superseded_needs_successor(env):
    s = capture("https://code.claude.com/docs/en/w.md", DOC, source="src:cc-docs-en")
    base = {"state": "superseded", "unit": "feature", "signals": sig(s, "The legacy mode is removed"), "decided_by": "agent:x"}
    r = run([ent(key="feature:old", typ="Feature", label="old", liveness=base)])
    assert res(r, "e1")["code"] == "E_SUCCESSOR_REQUIRED"
    r = run([ent(ref="e0", key="feature:new", typ="Feature", label="new",
                 liveness={"state": "active", "unit": "feature", "signals": sig(s, "The legacy mode is removed"), "decided_by": "agent:x"}),
             ent(key="feature:old", typ="Feature", label="old", liveness=dict(base, successor="e0"))])
    assert res(r, "e1")["result"] == "accepted"


def test_no_evidence_liveness(env):
    r = run([ent(key="feature:old", typ="Feature", label="old", liveness={"state": "removed", "unit": "feature", "signals": [],
                                                                         "decided_by": "agent:x"})])
    assert res(r, "e1")["code"] == "E_NO_EVIDENCE"


def test_denied_host_snapshot_is_rejected(env):
    r = run([{"item": "snapshot", "ref": "s1", "url": "https://www.youtube.com/watch?v=abc", "source": "src:adhoc"},
             {"item": "snapshot", "ref": "s2", "url": "https://sec.gov/x", "source": "src:adhoc"}], fetch=True)
    assert res(r, "s1")["code"] == "E_POLICY" and res(r, "s2")["code"] == "E_POLICY"


def test_unregistered_url_only_through_adhoc(env):
    r = run([{"item": "snapshot", "ref": "s1", "url": "https://example.org/a", "source": "src:cc-docs-en"},
             {"item": "snapshot", "ref": "s2", "url": "https://example.org/a", "source": "src:nope"}], fetch=False)
    assert res(r, "s1")["code"] == "E_POLICY" and res(r, "s2")["code"] == "E_POLICY"


def test_ticket_header_makes_answers_edges(env, doc):
    items = [ent(), claim(doc, "stores 5 widgets per page", "Widget Toolkit stores 5 widgets per page."),
             claim(doc, "exits with code 0 on success", "Widget Toolkit exits with code 9 on success.", ref="c2")]
    rep = run(items, write=True, ticket="t-abc123")
    c1, c2 = res(rep, "c1"), res(rep, "c2")
    assert c1["result"] == "accepted" and c2["result"] == "needs_review" and c2["code"] == "R_VALUE_MISMATCH"
    g = gold()
    try:
        rows = g.execute("SELECT src, dst FROM edge WHERE rtype='ANSWERS' AND expired_at IS NULL").fetchall()
    finally:
        g.close()
    assert rows == [(c1["would_be"]["id"], "t-abc123")]          # 수락된 주장마다. needs_review는 제외


@pytest.mark.parametrize("kw", [{"changed_on": "Oct 2026"}, {"valid": {"from": "Oct 2026"}},
                                {"valid": {"from": "2026-03-01", "to": "next week"}}])
def test_unparseable_claim_dates_are_E_SCHEMA_in_validate_and_submit(env, doc, kw):
    from kb import ingest
    from .conftest import bundle
    items = [ent(), claim(doc, "3.0 was released on 2026-03-01", "Widget Toolkit 3.0 was released on 2026-03-01.", **kw)]
    assert res(run(items), "c1")["code"] == "E_SCHEMA"
    rep = ingest.submit(bundle(items), fetch=False)
    assert res(rep, "c1")["result"] == "rejected" and res(rep, "c1")["code"] == "E_SCHEMA"


def test_idem_conflict_is_a_rejection_not_accepted(env, doc, monkeypatch):
    from kb import write
    from kb.write.errors import IdemConflict
    real = write.commit

    def conflict(events, *a, **k):
        if any(e["kind"] == "claim.assert" for e in events):
            raise IdemConflict("ingest:claim:x", "다른 내용")
        return real(events, *a, **k)
    monkeypatch.setattr(write, "commit", conflict)
    r = run([ent(), claim(doc, "stores 5 widgets per page", "Widget Toolkit stores 5 widgets per page.")], write=True)
    assert res(r, "c1")["result"] == "rejected" and res(r, "c1")["code"] == "E_POLICY"
