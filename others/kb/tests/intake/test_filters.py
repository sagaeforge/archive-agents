import json
import os

import pytest

from ihelp import FAKE_PAT, NODE
from kb.core import spool
from kb.intake import core, deny
from kb.intake.scrub import Scrubber
from pathlib import Path


def mats(man):
    dn = deny.load()
    return {m.item["id"]: m for m in core._collect(man, dn)}


def test_line_rules():
    s = Scrubber([NODE])
    bad = ["a 192.0.2.1 b", "10.x.x.x", "127.0.0.1:80", "169.254.1.1", "fd00::1 x", "fe80::1", "::1",
           "http://localhost:3000/x", "foo.local", "a.b.lan", "x.internal.", "h.home.arpa", f"x {NODE.upper()} y",
           "scopes: a", "X-OAuth-Scopes: repo", "Token permissions: read"]
    ok = ["1.2.3.4", "버전 10.0.19045.5011", ".claude/settings.local.json", "CLAUDE.local.md", "localhost", "std::vector<int>",
          "12:34:56", "https://example.org/a"]
    assert all(s.bad(x) for x in bad), [x for x in bad if not s.bad(x)]
    assert not any(s.bad(x) for x in ok), [x for x in ok if s.bad(x)]


def test_full_drops_whole_lines_and_counts(sample):
    man, _ = sample
    m = mats(man)["i-full"]
    assert m.scrubbed == 5  # 사설 주소, 노드, scopes, internal host, localhost 포트
    for frag in ("192.0.2.1", NODE, "scopes", "host.internal", "localhost:8080"):
        assert frag not in m.body
    assert "정상 줄 하나" in m.body and "제목" in m.body


def test_exclude_lines_and_urls(sample):
    man, _ = sample
    m = mats(man)["i-filt"]
    assert "line 3" not in m.body and "line 5" not in m.body and "line 4" in m.body and m.scrubbed == 2


def test_jsonl_join_only_selected_label(sample):
    man, _ = sample
    m = mats(man)["i-jsonl"]
    assert "trail fact" in m.body and "OTHER-LABEL-FACT" not in m.body and "investigate:repo" not in m.body


def test_versions_only(sample):
    man, _ = sample
    b = mats(man)["i-lock"].body
    assert "zod 4.6.7" in b and "other" not in b and "missing-pkg (잠금 파일에 없음)" in b


def test_index_has_no_content(sample):
    man, _ = sample
    b = mats(man)["i-idx"].body
    assert "a.txt" in b and "sub/b.txt" in b and "alpha" not in b and len(b.split("\t")) >= 5


def test_urls_only_and_excluded_do_not_open_body(sample):
    man, tr = sample
    os.chmod(tr, 0)
    try:
        m = mats(man)
    finally:
        os.chmod(tr, 0o644)
    u = m["i-urls"]
    assert u.resolved and "TRANSCRIPT-BODY-SENTINEL" not in u.body
    assert "https://example.org/pub1" in u.body and "10.x.x.x" not in u.body and "svc.internal" not in u.body
    assert u.scrubbed == 2
    h = m["i-html"]
    assert "pub2" in h.body and "192.0.2.1" not in h.body and "<a href" not in h.body and NODE not in h.body
    assert m["i-ex"].body is None and m["i-ex"].resolved  # 없는 경로여도 열지 않으니 해결됨


def test_missing_file_is_unresolved_not_fatal(sample):
    man, _ = sample
    man["items"].append({"id": "i-gone", "session": "sess-a", "project": "p", "researched_on": "2026-10-31",
                         "topic": "사라진 자료", "treat": "full", "path": "/nonexistent/x.md"})
    r = core.plan(man)
    assert r["unresolved"] == 1 and r["unresolved_ids"] == ["i-gone"]


def test_secret_sample_is_quarantined(sample):
    man, _ = sample
    r = core.run(man)
    assert r["secret_hits"] == 1
    held = [e for _, o in spool.iter_items("fp-held") for e in o["events"] if e["idem_key"].startswith("intake:i-secret:")]
    p = held[0]["payload"]
    assert p["sensitivity"] == "secret" and p["props"]["quarantine"] is True
    assert FAKE_PAT not in json.dumps(r)
