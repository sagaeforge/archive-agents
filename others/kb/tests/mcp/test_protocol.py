from kb.read.budget import est_tokens

TOOLS = {"kb_search", "kb_get", "kb_related", "kb_history", "kb_source", "kb_request", "kb_put", "kb_status"}


def test_tools_list_shape(server):
    init = server.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    ins = init["result"].get("instructions") or ""
    assert 0 < len(ins) <= 4096 and "kb_search" in ins and "WebSearch" in ins
    tools = server.tools()
    assert {t["name"] for t in tools} == TOOLS and len(tools) == 8
    for t in tools:
        assert "outputSchema" not in t or t["outputSchema"] is None
        assert "mcp__" not in (t.get("description") or "")
        assert len(t.get("description") or "") < 400
    meta = {t["name"]: (t.get("_meta") or {}).get("anthropic/alwaysLoad") for t in tools}
    assert meta["kb_search"] is True and not any(v for k, v in meta.items() if k != "kb_search")
    search = next(t for t in tools if t["name"] == "kb_search")
    assert "한영 표현을 배열로" in search["description"]


def test_results_are_plain_text(server):
    for name, args in (("kb_search", {"q": "hooks"}), ("kb_get", {"ids": ["e:feature:claude-code-hooks"]}),
                       ("kb_status", {})):
        text, err, res = server.call(name, **args)
        assert not err and text
        assert "structuredContent" not in res
        assert [c["type"] for c in res["content"]] == ["text"]
        assert "resource_link" not in str(res)


def test_resource_templates_and_reads(server, kbenv):
    r = server.rpc("resources/templates/list")["result"]["resourceTemplates"]
    uris = sorted(t["uriTemplate"] for t in r)
    assert uris == ["kb://node/{id}", "kb://snapshot/{id}"] and all(u.startswith("kb://") for u in uris)
    node, _ = server.read("kb://node/e:feature:claude-code-hooks")
    assert node and "e:feature:claude-code-hooks" in node
    series, _ = server.read("kb://node/s:test-views")
    assert series and series.startswith("s:test-views")
    snap, _ = server.read("kb://snapshot/" + kbenv.ids["snapshot"])
    assert snap and "Claude Code hooks run shell commands" in snap
    none, raw = server.read("kb://node/e:feature:nothing-here")
    assert none is None or "없음" in none
    bad, _ = server.read("kb://node/..%2Fetc")
    assert bad is None or "없음" in bad


def test_card_format_and_tokens(server):
    text, err, _ = server.call("kb_search", q="hooks", budget=900)
    head = text.splitlines()[0]
    assert head.startswith("#kb v1 seq=") and " r=" in head and " n=" in head and " more=" in head
    assert est_tokens(text) <= 900
    for ln in text.splitlines()[1:]:
        assert ln.count("\t") == 4 or ln.startswith("~ ")


def test_tool_errors_are_short_text_with_next_action(server):
    text, err, _ = server.call("kb_get", ids=["c-doesnotexist"])
    assert not err and "없음" in text
    text, err, _ = server.call("kb_related", id="c-doesnotexist")
    assert err and "다음 행동" in text
    text, err, _ = server.call("kb_search", q=[])
    assert err and "다음 행동" in text
