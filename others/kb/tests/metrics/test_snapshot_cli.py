import json
import subprocess
import sys

from kb.metrics.snapshot import snapshot

from .conftest import NOW

KEYS = ("yield", "tokens", "failures", "freshness", "retrieval", "recovery", "llm")


def test_empty_snapshot_has_keys(ops):
    s = snapshot(ops, now_ms=NOW)
    for k in KEYS:
        assert k in s
    assert s["yield"]["fetch"]["total"] == 0 and s["retrieval"]["zero_rate"] == 0.0


def test_fetch_and_query_aggregates(ops):
    t = NOW - 1000
    for oc in ("captured", "not_modified", "not_modified", "error", "robots_denied"):
        ops.execute("INSERT INTO fetch_log(at, source_id, host, url, status, outcome, bytes, ms) VALUES(?,?,?,?,?,?,?,?)",
                    (t, "s1", "h", "u", 200, oc, 1, 1))
    for z in (0, 1):
        ops.execute("INSERT INTO query_log(at, tool, cards, tokens, ms, route, zero) VALUES(?,?,?,?,?,?,?)", (t, "kb_search", 1, 10, 5, "lexical", z))
    ops.execute("INSERT INTO query_log(at, tool, cards, tokens, ms, route, zero) VALUES(?,?,?,?,?,?,?)", (t, "kb_get", 1, 10, 5, "lexical", 0))
    s = snapshot(ops, now_ms=NOW)
    f = s["yield"]["fetch"]
    assert f["ok"] == 3 and f["not_modified"] == 2 and f["changed"] == 1
    assert s["yield"]["by_source"]["s1"]["failed"] == 1
    assert s["failures"]["fetch_errors"] == 1
    assert s["retrieval"]["calls"] == 3 and s["retrieval"]["zero_rate"] == round(1 / 3, 4)
    assert s["retrieval"]["get_followup_rate"] == 0.5


def test_cli_json(kb_home):
    r = subprocess.run([sys.executable, "-I", "-m", "kb", "metrics", "--week", "--json"], capture_output=True, text=True,
                       env={"KB_HOME": str(kb_home), "PATH": "/usr/bin:/bin", "PYTHONPATH": ""}, cwd=str(kb_home))
    assert r.returncode == 0, r.stderr[-300:]
    assert set(KEYS) <= set(json.loads(r.stdout))
