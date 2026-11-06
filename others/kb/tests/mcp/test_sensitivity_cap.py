"""private, secret 레코드는 모든 도구에서 없는 것과 같다. 환경 변수와 인자로 올릴 수 없다."""
import pytest

from kb.write import put_record

WORD = "capwordzx"
LINK = [{"rtype": "LINKS_TO", "dst": "e:feature:claude-code-hooks"}]


@pytest.fixture(scope="module")
def hidden(kbenv):
    out = {}
    for sens in ("private", "secret"):
        r = put_record({"type": "Note", "title": f"{sens} {WORD} 노트", "body": f"{WORD} {sens} 본문", "sensitivity": sens,
                        "links": LINK}, f"cap-{sens}", "mcp", session="cap")
        assert r.projected and not r.held
        out[sens] = r.id
    r = put_record({"type": "Note", "title": f"internal {WORD} 노트", "body": f"{WORD} internal 본문", "sensitivity": "internal",
                    "links": LINK}, "cap-internal", "mcp", session="cap")
    out["internal"] = r.id
    return out


def run_all(m, ids, kbenv, extra=None):
    extra = extra or {}
    s, err, _ = m.call("kb_search", q=WORD, k=50, budget=6000, **extra)
    assert not err
    for k in ("private", "secret"):
        assert ids[k] not in s
    assert ids["internal"] in s            # 대조: internal은 읽힌다
    for k in ("private", "secret"):
        g, err, _ = m.call("kb_get", ids=[ids[k]], view="full", **extra)
        blank, _, _ = m.call("kb_get", ids=["f-neverexistedxx"], view="full", **extra)
        assert g.replace(ids[k], "<ID>") == blank.replace("f-neverexistedxx", "<ID>")
        for tool, args in (("kb_related", {"id": ids[k]}), ("kb_history", {"id": ids[k]}), ("kb_source", {"id": ids[k]})):
            t, err, _ = m.call(tool, **args)
            assert err and "없음" in t, (tool, t)
    r, err, _ = m.call("kb_related", id="e:feature:claude-code-hooks", limit=200, budget=6000)
    assert not err and ids["internal"] in r and ids["private"] not in r and ids["secret"] not in r
    gg, _, _ = m.call("kb_get", ids=["e:feature:claude-code-hooks"], view="graph", budget=6000)
    assert ids["private"] not in gg and ids["secret"] not in gg


def test_hidden_on_every_tool(server, hidden, kbenv):
    run_all(server, hidden, kbenv)
    for k in ("private", "secret"):
        t, _ = server.read("kb://node/" + hidden[k])
        assert t is None or "없음" in t


def test_cannot_raise_by_env_or_args(factory, hidden, kbenv):
    env = {"KB_MAX_SENSITIVITY": "secret", "KB_MCP_MAX_SENSITIVITY": "secret", "KB_SENSITIVITY": "secret",
           "KB_OWNER": "1", "KB_MCP_SESSION": "user:sagae"}
    m = factory(env)
    run_all(m, hidden, kbenv)
    for extra in ({"max_sensitivity": "secret"}, {"sensitivity": "private"}):
        s, err, _ = m.call("kb_search", q=WORD, k=50, budget=6000, **extra)
        assert hidden["private"] not in s and hidden["secret"] not in s


def test_collector_profile_also_hides(factory, hidden):
    c = factory(args=("--profile", "collector"))
    s, err, _ = c.call("kb_search", q=WORD, k=50, budget=6000)
    assert not err and all(v not in s for v in hidden.values())
