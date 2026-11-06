import os
import time

from kb.write import tick_stage
from kb.write import inbox
from kb.core import paths
from wrhelp import events, gold_row

NOTE = """---
type: Note
title: 쇼츠 후킹 메모
sensitivity: internal
links: [e:platform:youtube-shorts]   # 링크
props:
  tag: shorts
---
본문은 Markdown이다. [[e:product:claude-code]]는 LINKS_TO 엣지가 된다.
"""


def put_file(name, text, age=100):
    d = paths.inbox_dir()
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text(text, encoding="utf-8")
    t = time.time() - age
    os.utime(f, (t, t))
    return f


def test_scan_skips_young_and_moves_done(fp_open):
    young = put_file("young.md", NOTE, age=1)
    old = put_file("old.md", NOTE.replace("쇼츠 후킹 메모", "오래된 메모"), age=100)
    r = inbox.scan()
    assert (r.seen, r.written, r.skipped_young) == (2, 1, 1)
    assert young.exists() and not old.exists()
    done = list((paths.inbox_dir() / ".done").glob("*/old.md"))
    assert len(done) == 1
    ev = events("kind='record.put'")
    assert len(ev) == 1 and (ev[0][3], ev[0][4]) == ("user:sagae", None)
    rows = gold_row("SELECT id, label, props FROM node WHERE type='Note' AND expired_at IS NULL")
    assert rows[0][1] == "오래된 메모" and "shorts" in str(rows[0][2])
    edges = gold_row("SELECT dst FROM edge WHERE src=? AND expired_at IS NULL ORDER BY dst", (rows[0][0],))
    assert [e[0] for e in edges] == ["e:platform:youtube-shorts", "e:product:claude-code"]
    # 파일을 지워도 레코드는 그대로, 같은 파일을 다시 넣어도 새 버전은 없다
    done[0].unlink()
    assert gold_row("SELECT count(*) FROM node WHERE type='Note' AND expired_at IS NULL")[0][0] == 1
    put_file("old.md", NOTE.replace("쇼츠 후킹 메모", "오래된 메모"))  # 같은 이름·같은 내용 재투입은 멱등
    inbox.scan()
    assert len(events("kind='record.put'")) == 1


def test_recover_stage_scans_inbox(fp_open):
    put_file("viaTick.md", NOTE)
    res = tick_stage.run()
    assert res.ok, res.errors
    assert res.detail["inbox"]["written"] == 1
    assert [s[1] for s in tick_stage.STAGES] == ["recover"] and tick_stage.STAGES[0][0] == 1


def test_base_version_conflict_never_overwrites(fp_open):
    put_file("n.md", NOTE)
    inbox.scan()
    rid = gold_row("SELECT id FROM node WHERE type='Note' AND expired_at IS NULL")[0][0]
    bad = NOTE.replace("type: Note", f"id: {rid}\nbase_version: 7\ntype: Note").replace("쇼츠 후킹 메모", "덮어쓰기 시도")
    f = put_file("n2.md", bad)
    r = inbox.scan()
    assert r.conflicts == ["n2.md"] and not f.exists()
    assert list((paths.inbox_dir() / ".conflict").glob("*/n2.md"))
    assert gold_row("SELECT label, version FROM node WHERE id=? AND expired_at IS NULL", (rid,)) == [("쇼츠 후킹 메모", 1)]
    # base_version 없는 기존 id도 충돌
    put_file("n3.md", NOTE.replace("type: Note", f"id: {rid}\ntype: Note").replace("쇼츠 후킹 메모", "또 시도"))
    assert inbox.scan().conflicts == ["n3.md"]
    # 맞는 base_version은 새 버전
    ok = NOTE.replace("type: Note", f"id: {rid}\nbase_version: 1\ntype: Note").replace("쇼츠 후킹 메모", "갱신")
    put_file("n4.md", ok)
    assert inbox.scan().written == 1
    assert gold_row("SELECT label, version FROM node WHERE id=? AND expired_at IS NULL", (rid,)) == [("갱신", 2)]


def test_invalid_file_goes_failed(fp_open):
    put_file("bad.md", "---\ntype: Note\nbogus_key: 1\n---\nx\n")
    r = inbox.scan()
    assert r.failed == ["bad.md"] and list((paths.inbox_dir() / ".failed").glob("*/bad.md"))


def test_closed_gate_holds_inbox_file_safely(wk):
    put_file("h.md", NOTE)
    r = inbox.scan()
    assert (r.held, r.written) == (1, 0)
    assert list((paths.spool_dir() / "fp-held").glob("*.json")) and list((paths.inbox_dir() / ".done").glob("*/h.md"))
