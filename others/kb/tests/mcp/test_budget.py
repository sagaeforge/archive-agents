from kb.read.budget import est_tokens
from kb.core.ids import check_public_id  # noqa: F401


def _hub(n=200):
    from kb.write import commit
    from kb.write.engine import project_pending
    evs = [{"kind": "entity.put", "actor": "collector", "origin": "external", "subject": "e:tool:hub", "idem_key": "hub",
            "payload": {"id": "e:tool:hub", "type": "Tool", "label": "허브 도구"}}]
    for i in range(n):
        eid = f"e:tool:peer{i:03d}"
        evs.append({"kind": "entity.put", "actor": "collector", "origin": "external", "subject": eid, "idem_key": f"peer{i}",
                    "payload": {"id": eid, "type": "Tool", "label": f"이웃 도구 {i} 매우 긴 라벨 이름입니다"}})
        evs.append({"kind": "edge.put", "actor": "collector", "origin": "external", "subject": f"r-hub{i:03d}", "idem_key": f"hubedge{i}",
                    "payload": {"id": f"r-hub{i:03d}", "src": "e:tool:hub", "rtype": "RELATED_TO", "dst": eid}})
    for k in range(0, len(evs), 100):
        commit(evs[k:k + 100], "collector")
    project_pending()


def test_every_tool_within_budget(server, kbenv):
    _hub()
    cases = [("kb_search", {"q": "hooks"}, 900), ("kb_search", {"q": "hooks", "budget": 300}, 300),
             ("kb_get", {"ids": [kbenv.ids["entity"]], "view": "full"}, 1500),
             ("kb_get", {"ids": [kbenv.ids["entity"]], "view": "graph", "budget": 200}, 200),
             ("kb_related", {"id": "e:tool:hub", "limit": 200}, 600),
             ("kb_related", {"id": "e:tool:hub", "limit": 200, "budget": 6000}, 6000),
             ("kb_history", {"id": kbenv.ids["entity"]}, 900),
             ("kb_source", {"id": kbenv.ids["snapshot"], "max_chars": 200000}, 1500),
             ("kb_source", {"id": kbenv.ids["snapshot"], "max_chars": 200000, "budget": 100}, 100),
             ("kb_status", {}, 300)]
    for name, args, budget in cases:
        text, err, _ = server.call(name, **args)
        assert not err, (name, text[:200])
        assert est_tokens(text) <= budget, (name, args, est_tokens(text), budget)


def test_budget_cap_is_6000(server):
    text, err, _ = server.call("kb_search", q="hooks", k=50, budget=99999)
    assert not err and est_tokens(text) <= 6000
    text, err, _ = server.call("kb_related", id="e:tool:hub", limit=200, budget=99999)
    assert not err and est_tokens(text) <= 6000


def test_neighbors_200(server):
    text, err, _ = server.call("kb_related", id="e:tool:hub", limit=200)
    assert not err
    assert est_tokens(text) <= 600
    assert "생략" in text      # 200건은 600토큰에 다 안 든다: 잘리면 알린다
