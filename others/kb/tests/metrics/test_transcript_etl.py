import json

from kb.metrics import transcript
from kb.metrics.snapshot import snapshot

from .conftest import NOW


def line(rid, i, o, cr=0, cc=0, model="m1", tools=()):
    return json.dumps({"type": "assistant", "requestId": rid, "message": {
        "model": model, "content": [{"type": "tool_use", "name": n} for n in tools] + [{"type": "text", "text": "PRIVATEBODY"}],
        "usage": {"input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cc}}})


def make(tmp, lines):
    d = tmp / "projects" / "p1"
    d.mkdir(parents=True)
    f = d / "s.jsonl"
    f.write_text("\n".join(lines) + "\n")
    return tmp / "projects", f


def test_token_sums_and_dedupe(ops, kb_home):
    root, f = make(kb_home, [line("r1", 10, 20, 5, 7, tools=["mcp__trail__trail_find_code"]),
                             line("r1", 10, 20, 5, 7),  # 같은 requestId는 한 번만
                             line("r2", 1, 2, tools=["mcp__kb__kb_search"]),
                             json.dumps({"type": "user", "message": {"content": "x"}})])
    r = transcript.etl(ops, root, NOW)
    assert r["tokens"] == 10 + 20 + 5 + 7 + 1 + 2 and r["parse_fail"] == 0
    s = snapshot(ops, now_ms=NOW + 1000)
    assert s["tokens"]["transcript"] == {"input": 11, "output": 22, "cache_read": 5, "cache_create": 7}
    assert s["retrieval"]["trail_mcp_calls"] == 1 and s["retrieval"]["kb_mcp_calls"] == 1
    assert s["transcript"]["files"] == 1 and s["transcript"]["parse_fail_rate"] == 0.0


def test_parse_fail_rate_increases_on_missing_fields(ops, kb_home):
    bad_usage = json.dumps({"type": "assistant", "requestId": "r9", "message": {"content": []}})
    bad_int = json.dumps({"type": "assistant", "requestId": "r8", "message": {"usage": {"input_tokens": "9", "output_tokens": 1}}})
    root, f = make(kb_home, [line("r1", 1, 1), "{not json", bad_usage, bad_int])
    r = transcript.etl(ops, root, NOW)
    assert r["parse_fail"] == 3 and r["lines"] == 4
    s = snapshot(ops, now_ms=NOW + 1000)
    assert s["transcript"]["parse_fail"] == 3 and s["transcript"]["parse_fail_rate"] == 0.75


def test_incremental_and_no_raw_copy(ops, kb_home):
    root, f = make(kb_home, [line("r1", 3, 4)])
    transcript.etl(ops, root, NOW)
    again = transcript.etl(ops, root, NOW)  # 변화 없음
    assert again["files"] == 0
    with open(f, "a") as fh:
        fh.write(line("r2", 1, 1) + "\n")
    assert transcript.etl(ops, root, NOW)["tokens"] == 2
    dump = json.dumps(ops.execute("SELECT * FROM metric").fetchall()) + json.dumps(ops.execute("SELECT * FROM tick_state").fetchall())
    assert "PRIVATEBODY" not in dump and str(root) not in dump
    assert not (root / "p1" / "s.jsonl").read_text() == ""  # 원본은 읽기만 했다
