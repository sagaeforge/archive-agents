import json

from kb.core import opsdb
from kb.metrics import retro
from kb.metrics.snapshot import snapshot

from .conftest import NOW, call


def leaves(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from leaves(v)
    elif isinstance(o, list):
        for v in o:
            yield from leaves(v)
    else:
        yield o


def test_input_is_numbers_only(ops):
    t = NOW - 1000
    secret_q = "SECRETQUERY how to bypass"
    url = "https://example.com/a/b?x=1"
    body = "RAWBODY 문단 본문 텍스트"
    ops.execute("INSERT INTO fetch_log(at, source_id, host, url, status, outcome, bytes, ms) VALUES(?,?,?,?,?,?,?,?)",
                (t, "src.one", "example.com", url, 200, "captured", 10, 5))
    ops.execute("INSERT INTO query_log(at, tool, cards, tokens, ms, route, zero) VALUES(?,?,?,?,?,?,?)",
                (t, "kb_search", 3, 100, 20, "lexical", 0))
    ops.execute("INSERT INTO dlq(kind, ref, stage, error, attempts) VALUES('window', ?, 'extract', ?, 1)", (url, body))
    ops.execute("INSERT INTO incident(at, kind, detail) VALUES(?, 'other', ?)", (t, secret_q))
    call(ops, t, window_text=body, query=secret_q, url=url, rejected_sample=body)
    inp = retro.build_input(snapshot(ops, now_ms=NOW))
    blob = json.dumps(inp, ensure_ascii=False)
    for bad in ("SECRETQUERY", "example.com", "RAWBODY", "http", "거부"):
        assert bad not in blob
    assert all(isinstance(x, (int, float, bool)) for x in leaves(inp["metrics"]))
    assert inp["metrics"]["yield"]["fetch"]["changed"] == 1
    assert "src.one" in inp["metrics"]["yield"]["by_source"]


def test_numeric_only_drops_url_keys_and_strings():
    r = retro.numeric_only({"a": 1, "https://x.y/z": 2, "s": "text", "n": {"k": "v", "m": 3.5}, "l": [1, "x", 2]})
    assert r == {"a": 1, "n": {"m": 3.5}, "l": [1, 2]}
