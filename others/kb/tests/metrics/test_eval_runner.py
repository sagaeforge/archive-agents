import json

import pytest

from kb.metrics import evalrun


def write(d, rows, name="a.jsonl"):
    (d / name).write_text("\n".join(json.dumps(r) for r in rows) + "\n")


H = "human:tester"


def test_runner_on_synthetic(tmp_path):
    write(tmp_path, [
        {"id": "q1", "kind": "query", "q": "alpha", "expect_ids": ["a", "b"], "verified_by": H},
        {"id": "q2", "kind": "query", "q": "beta", "expect_ids": ["z"], "verified_by": H},
        {"id": "e1", "kind": "extract", "text": "t1", "expect": [{"subject": "S1"}, {"subject": "S2"}], "verified_by": H},
        {"id": "e2", "kind": "extract", "text": "t2", "expect": [{"subject": "S3"}, {"subject": "S4"}], "recall_sample": True, "verified_by": H},
        {"id": "s1", "kind": "stale_premise", "premise": "p", "annotation": "a", "correct": True, "verified_by": H},
        {"id": "s2", "kind": "stale_premise", "premise": "p", "annotation": "b", "correct": False, "verified_by": H},
        {"id": "s3", "kind": "stale_premise", "premise": "p", "annotation": "c", "correct": False, "verified_by": H},
    ])
    res = {"alpha": ["a", "x", "b"], "beta": ["y"]}
    ext = {"t1": [{"subject": "S1"}, {"subject": "BAD"}], "t2": [{"subject": "S3"}]}
    cases, rej = evalrun.load_cases(tmp_path)
    assert len(cases) == 7 and rej == []
    out = evalrun.evaluate(cases, search_fn=res.__getitem__, extract_fn=ext.__getitem__, accept_fn=lambda c: c["id"] in ("s1", "s2"))
    assert out["cases"] == 7
    assert out["query"] == {"n": 2, "recall_at_k": round(2 / 3, 4), "mrr": 0.5}
    assert out["extract"]["tp"] == 1 and out["extract"]["fp"] == 1 and out["extract"]["fn"] == 1
    assert out["extract"]["precision"] == 0.5 and out["extract"]["recall"] == 0.5
    assert out["recall_sample"] == {"n": 1, "recall": 0.5}
    assert out["stale_premise"]["accept_correct"] == 1.0 and out["stale_premise"]["accept_wrong"] == 0.5


def test_rejects_self_generated_gold(tmp_path):
    write(tmp_path, [
        {"id": "ok", "kind": "query", "q": "x", "expect_ids": ["a"], "verified_by": H},
        {"id": "m1", "kind": "query", "q": "x", "expect_ids": ["a"], "verified_by": H, "origin": "model"},
        {"id": "m2", "kind": "query", "q": "x", "expect_ids": ["a"], "verified_by": "claude"},
        {"id": "m3", "kind": "query", "q": "x", "expect_ids": ["a"]},
        {"id": "m4", "kind": "query", "q": "x", "expect_ids": ["a"], "verified_by": H, "origin": "kb_output"},
    ])
    cases, rej = evalrun.load_cases(tmp_path)
    assert [c["id"] for c in cases] == ["ok"]
    assert {r["id"]: r["why"] for r in rej} == {"m1": "self_generated", "m2": "not_human_verified",
                                                 "m3": "not_human_verified", "m4": "self_generated"}
    with pytest.raises(evalrun.SelfGeneratedGold):
        evalrun.load_cases(tmp_path, strict=True)


def test_empty_suite_gives_zero_cases(tmp_path):
    (tmp_path / "golden").mkdir()
    out = evalrun.run_suite("golden", tmp_path)
    assert out["cases"] == 0 and out["rejected"] == 0
