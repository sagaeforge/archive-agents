"""수집 프로필의 읽기 도구는 공개 범위(external, sensitivity 0)만 돌려준다. 숨긴 레코드는 없는 것과 같다."""
import re

HIDE = ("pub", "int", "prv", "extint")      # first_party public, first_party internal, private, external internal


def norm(text, i):
    return text.replace(i, "<ID>")


def test_collector_hides_first_party_and_sensitive(factory, kbenv):
    c = factory(args=("--profile", "collector"))
    ids = kbenv.ids
    s, err, _ = c.call("kb_search", q="hooks", k=50, budget=6000)
    assert not err and s.count("\nc-") > 3     # 공개 external 카드는 그대로 나온다
    for k in HIDE:
        assert ids[k] not in s
    assert "f-" not in " ".join(ln.split("\t")[0] for ln in s.splitlines()[1:])
    blank, _, _ = c.call("kb_get", ids=["f-neverexisted"])
    for k in HIDE:
        t, err, _ = c.call("kb_get", ids=[ids[k]])
        assert not err and norm(t, ids[k]) == norm(blank, "f-neverexisted"), (k, t)
        t2, err2, _ = c.call("kb_source", id=ids[k])
        b2, berr2, _ = c.call("kb_source", id="f-neverexisted")
        assert err2 and berr2 and norm(t2, ids[k]) == norm(b2, "f-neverexisted")
    # 공개 external 레코드는 그대로 읽힌다
    t, err, _ = c.call("kb_get", ids=[ids["entity"]], view="full")
    assert not err and "없음" not in t.splitlines()[0] and t.startswith(ids["entity"])
    src, err, _ = c.call("kb_source", id=ids["snapshot"])
    assert not err and "Claude Code hooks run shell commands" in src


def test_cannot_widen_by_env_or_args(factory, kbenv):
    ids = kbenv.ids
    env = {"KB_MAX_SENSITIVITY": "private", "KB_MCP_MAX_SENSITIVITY": "secret", "KB_SENSITIVITY": "secret", "KB_ORIGIN": "first_party",
           "KB_PROFILE": "default", "KB_MCP_PROFILE": "default"}
    c = factory(env, args=("--profile", "collector"))
    for extra in ({}, {"max_sensitivity": "private"}, {"origin": "first_party"}, {"include": "unverified"}):
        s, err, _ = c.call("kb_search", q="hooks", k=50, budget=6000, **extra)
        for k in HIDE:
            assert ids[k] not in s, (extra, k)
    for extra in ({}, {"max_sensitivity": "private"}, {"origin": "first_party"}):
        t, err, _ = c.call("kb_get", ids=[ids["prv"], ids["int"], ids["pub"]], **extra)
        assert all(ids[k] not in t.replace("없음", "") or t.count("없음") for k in HIDE)
        assert t.count("없음") == 3 or err


def test_default_profile_reads_the_same_internal_sample(server, kbenv):
    ids = kbenv.ids
    t, err, _ = server.call("kb_get", ids=[ids["int"], ids["extint"], ids["pub"]])
    assert not err and "없음" not in t
    assert ids["int"] in t and ids["extint"] in t and ids["pub"] in t
    s, _, _ = server.call("kb_search", q="hooks", k=50, budget=6000)
    assert ids["int"] in s
