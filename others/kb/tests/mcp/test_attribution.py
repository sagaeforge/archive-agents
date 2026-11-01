import json

from kb import read


def put(m, title, key, **rec):
    text, err, _ = m.call("kb_put", record={"title": title, "body": "본문 attribution", **rec}, idempotency_key=key)
    assert not err, text
    return json.loads(text)["id"]


def node(rid):
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    with read.reading(ctx) as con:
        return read.get_node(con, ctx, rid, include=())


def test_env_session_becomes_author_and_card_mark(factory):
    m = factory({"KB_MCP_SESSION": "tower"})
    rid = put(m, "tower 귀속", "attr-tower")
    d = node(rid)
    assert d["author"] == "agent:tower" and d["on_behalf_of"] == "user:sagae"
    cards, _, _ = m.call("kb_search", q="tower 귀속 attribution")
    line = next(ln for ln in cards.splitlines() if ln.startswith(rid))
    assert line.split("\t")[4].startswith("f:agent:tower")


def test_custom_session_value(factory):
    m = factory({"KB_MCP_SESSION": "sess-7f3a"})
    assert node(put(m, "세션 값", "attr-custom"))["author"] == "agent:sess-7f3a"


def test_without_env_each_process_has_own_session(factory):
    a, b = factory(), factory()
    da, db = node(put(a, "A 프로세스", "attr-a")), node(put(b, "B 프로세스", "attr-b"))
    assert da["author"].startswith("agent:s-") and db["author"].startswith("agent:s-")
    assert da["author"] != db["author"]
    same = node(put(a, "A 프로세스 둘째", "attr-a2"))
    assert same["author"] == da["author"]


def test_props_session_does_not_change_author(factory):
    m = factory({"KB_MCP_SESSION": "tower"})
    rid = put(m, "자기 신고", "attr-props", props={"session": "f-user-evil"})
    d = node(rid)
    assert d["author"] == "agent:tower" and d["props"]["session"] == "f-user-evil"
