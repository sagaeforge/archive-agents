import json

from kb.metrics import retro

from .conftest import NOW


def test_filter_excludes_policy_trust_claudemd_and_bad_targets():
    props = [
        {"target": "prompt", "change": "extract-2 프롬프트 창 길이 조정", "metric": "llm.quality"},
        {"target": "cadence", "change": "수집 주기 단축", "metric": "freshness"},
        {"target": "policy", "change": "소스 policy 완화", "metric": "x"},
        {"target": "vocabulary", "change": "소스 trust 올리기", "metric": "y"},
        {"target": "adapter", "change": "CLAUDE.md 지침 수정", "metric": "z"},
        {"target": "prompt", "change": "robots 예외 추가", "metric": "w"},
        "junk",
    ]
    keep, dropped = retro.filter_proposals(props)
    assert [p["target"] for p in keep] == ["prompt", "cadence"]
    assert dropped == 5


def test_proposals_are_not_applied_and_doc_written(kb_home, ops, repo):
    from kb.metrics.snapshot import snapshot
    before = {str(p): p.stat().st_mtime_ns for p in (repo / "src" / "kb").rglob("*.py")}
    snap = snapshot(ops, now_ms=NOW)
    out = retro.run(snap, proposals=[{"target": "prompt", "change": "창 길이 4000", "metric": "m"},
                                      {"target": "prompt", "change": "trust 변경", "metric": "m"}])
    assert out["proposals"] == 1 and out["dropped"] == 1 and out["called"] is False
    doc = open(out["path"], encoding="utf-8").read()
    assert str(kb_home) in out["path"] and "/ops/retro/" in out["path"] and out["path"].endswith(".md")
    assert "창 길이 4000" in doc and "trust 변경" not in doc and "적용되지 않았다" in doc
    after = {str(p): p.stat().st_mtime_ns for p in (repo / "src" / "kb").rglob("*.py")}
    assert before == after


def test_dry_run_calls_nothing(ops):
    from kb.metrics.snapshot import snapshot
    out = retro.run(snapshot(ops, now_ms=NOW), dry_run=True)
    assert out["called"] is False and out["path"] is None and "input" in out


def test_proposals_from_events():
    ev = [{"type": "result", "result": "```json\n" + json.dumps({"proposals": [{"target": "prompt", "change": "c", "metric": "m"}], "incidents": []}) + "\n```"}]
    assert retro.proposals_from_events(ev)[0]["target"] == "prompt"
