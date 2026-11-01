import re

import pytest

from kb.core import ids

PAT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]*$")


def test_public_id_rejects():
    for bad in ("a/b", "a?b", "a#b", "a,b", "a b", "a\tb", "a\nb", "", "-a", ":a", "a\n", "한글", "x" * 300):
        with pytest.raises(ValueError):
            ids.check_public_id(bad)
    for good in ("e:feature:claude-code-hooks", "c-abc123", "s:kworb-yt", "src:cc.docs", "n-0a"):
        assert ids.check_public_id(good) == good


def test_entity_id():
    assert ids.entity_id("Feature", "claude-code-hooks") == "e:feature:claude-code-hooks"
    assert ids.entity_id("repo", "a.b_c-d") == "e:repo:a.b_c-d"
    for slug in ("..", "", ".", "a..b", "-a", "a-", "A", "a b", "a/b", "a:b", "한글"):
        with pytest.raises(ValueError):
            ids.entity_id("tool", slug)
    for t in ("", "a:b", "1x", "a b"):
        with pytest.raises(ValueError):
            ids.entity_id(t, "ok")


def test_deterministic_ids():
    u = "HTTPS://Example.com:443/a?b=1#frag"
    assert ids.document_id(u) == ids.document_id("https://example.com/a?b=1") == ids.document_id(u)
    assert re.fullmatch(r"d-[0-9a-f]{16}", ids.document_id(u))
    assert ids.document_id("https://example.com/") == ids.document_id("https://example.com")
    assert ids.document_id("https://example.com/a") != ids.document_id("https://example.com/b")
    raw = "ab" * 32
    s1 = ids.snapshot_id(raw, u)
    assert s1 == ids.snapshot_id(raw, u) and re.fullmatch(r"n-[0-9a-f]{16}", s1)
    assert s1 != ids.snapshot_id(raw, "https://example.com/other")
    assert s1 != ids.snapshot_id("cd" * 32, u)
    e1 = ids.evidence_id("c-x", s1, {"k": "text_quote", "start": 1, "end": 5})
    assert e1 == ids.evidence_id("c-x", s1, {"end": 5, "start": 1, "k": "text_quote"})
    assert re.fullmatch(r"ev-[a-z2-7]{12}", e1)
    assert e1 != ids.evidence_id("c-y", s1, {"k": "text_quote", "start": 1, "end": 5})
    assert ids.edge_id("e:a:x", "USES", "e:a:y") == ids.edge_id("e:a:x", "USES", "e:a:y", {})
    assert ids.edge_id("e:a:x", "USES", "e:a:y") != ids.edge_id("e:a:y", "USES", "e:a:x")


def test_claim_ids():
    a = ids.claim_id_llm("e:tool:x", "한  줄\n인용구")
    assert a == ids.claim_id_llm("e:tool:x", "한 줄 인용구") and re.fullmatch(r"c-[a-z2-7]{12}", a)
    assert a != ids.claim_id_llm("e:tool:y", "한 줄 인용구")
    d = ids.claim_id_det("e:tool:x", "price", {"plan": "pro"}, "20", "2026-10")
    assert d == ids.claim_id_det("e:tool:x", "price", {"plan": "pro"}, "20", "2026-10")
    assert d != ids.claim_id_det("e:tool:x", "price", {"plan": "pro"}, "21", "2026-10")


def test_all_outputs_are_public_ids():
    outs = [ids.claim_id_llm("e:a:b", "q"), ids.claim_id_det("e:a:b", "p"), ids.snapshot_id("0" * 64, "https://a.b/"),
            ids.document_id("https://a.b/"), ids.edge_id("e:a:b", "T", "e:a:c"), ids.evidence_id("c-1", "n-1", "s"),
            ids.record_id(), ids.ticket_id(), ids.series_id("a-b"), ids.source_id("a-b"), ids.entity_id("tool", "x")]
    for o in outs:
        assert PAT.fullmatch(o) and ids.check_public_id(o) == o


def test_uuid7_monotonic():
    xs = [ids.uuid7() for _ in range(2000)]
    assert xs == sorted(xs) and len(set(xs)) == len(xs)
    assert all(x[14] == "7" and x[19] in "89ab" for x in xs)


def test_userinfo_url_rejected():
    with pytest.raises(ValueError):
        ids.document_id("https://user:pw@example.com/")
