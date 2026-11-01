import pytest

from kb.write import WriteRejected, commit
from wrhelp import ev


def claim(pred, stance="stated", props=None, key="r6"):
    p = {"id": "c-" + key, "subject": "e:concept:x", "predicate": pred, "value": "1", "statement": "표본 문장", "kind": "state", "stance": stance,
         "method": "deterministic", "verification": "parser_derived",
         "evidence": [{"snapshot": "n-1", "selector_kind": "jsonpointer", "json_pointer": "/a"}]}
    if stance == "attributed":
        p["speaker"] = "e:org:billboard"
    if props:
        p["qualifiers"] = props
    return ev("claim.assert", p, "c-" + key, key, origin="system")


def test_system_score_and_recommendation_rejected():
    for i, pred in enumerate(("opportunity_score", "score", "recommendation")):
        with pytest.raises(WriteRejected) as ei:
            commit([claim(pred, key=f"a{i}")])
        assert ei.value.code == "policy_r6"
    with pytest.raises(WriteRejected):
        commit([claim("chart_rank", props={"opportunity_score": 9}, key="b")])
    with pytest.raises(WriteRejected):
        commit([ev("entity.put", {"id": "e:concept:z", "type": "Concept", "label": "z", "props": {"recommended": True}},
                   "e:concept:z", "c")])
    with pytest.raises(WriteRejected):
        commit([ev("edge.put", {"id": "x", "src": "e:a:b", "rtype": "USES", "dst": "e:a:c", "props": {"score": 3}},
                   "x", "d")])


def test_attributed_rank_and_user_judgement_pass(wk):
    r = commit([claim("chart_rank", stance="attributed", key="ok1")])
    assert r.seq is not None
    commit([claim("recommends", stance="attributed", key="ok2")])
    from kb.write import put_record
    from wrhelp import open_fp_direct
    open_fp_direct()
    res = put_record({"type": "Decision", "title": "추천 결정", "body": "점수 높은 순으로 간다",
                      "props": {"score": 5, "recommendation": "A안"}}, "r6-user", "inbox")
    assert res.version == 1
