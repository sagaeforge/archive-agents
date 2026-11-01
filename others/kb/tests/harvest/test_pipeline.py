import os
from pathlib import Path

import pytest

from conftest import FAKE_PAT, NODE, all_bytes, tree
from kb import ticket
from kb.core import ledger, spool
from kb.harvest import core, filters
from kb.intake import deny
from wrhelp import count_events

OLD_PLUS = 1_700_000_000


def scrubber():
    return filters.HarvestScrubber(deny.load())


def harvest_events():
    """원장과 보관(spool)의 harvest record.put 이벤트."""
    out = []
    if ledger.ledger_path().exists():
        c = ledger.open_ledger()
        try:
            out += [e for e in ledger.iter_events(c, 0, 100000)
                    if e["kind"] == "record.put" and e["idem_key"].startswith("harvest:")]
        finally:
            c.close()
    for _, obj in spool.iter_items("fp-held"):
        out += [dict(e, held=True) for e in obj["events"] if e["kind"] == "record.put" and e["idem_key"].startswith("harvest:")]
    out.sort(key=lambda e: (e["subject"], int(e["idem_key"].split(":")[2][1:])))
    return out


def held_files():
    d = spool.dir_of("fp-held")
    return sorted(d.glob("*.json")) if d.is_dir() else []


def kinds_in_ledger():
    c = ledger.open_ledger()
    try:
        return {r[0] for r in c.execute("SELECT DISTINCT kind FROM event")}
    finally:
        c.close()


def populate(world):
    world.memory(name="a.md", body="메모 본문 하나\n둘째 줄\n", desc="메모 제목 A")
    world.journal([("research:a", {"summary": "워크플로우 요약 문장이다. " * 4, "status": "done"})])
    world.agent("에이전트 최종 보고다. " * 15, description="에이전트 보고 제목")
    world.doc("topic.md", "# 조사 문서 제목\n\n조사 본문이 여기에 있다. 충분히 긴 문장으로 쓴다.\n")


# ------------------------------------------------------------------ 저장 형식

def test_stores_learning_agent_records_without_claims(world, mode):
    populate(world)
    rep = core.run(world.cfg())
    assert rep["candidates"] == 4 and rep["actions"] == {"new": 4}
    assert rep["writes"]["held" if mode == "held" else "stored"] == 4
    evs = harvest_events()
    assert len(evs) == 4
    for e in evs:
        assert e["actor"] == "agent:harvest" and e["on_behalf_of"] == "user:sagae" and e["origin"] == "first_party"
        p = e["payload"]
        assert p["type"] == "Learning" and p["sensitivity"] == "internal" and p["body_format"] == "markdown"
        pr = p["props"]
        assert pr["tags"] == ["harvest", pr["source_kind"]] and pr["content_sha"] and pr["source_date"] and pr["project"]
        assert pr["source_path"].startswith(("~/", "/")) and "scrubbed_lines" in pr
        assert "quarantine" not in pr
    by_kind = {e["payload"]["props"]["source_kind"]: e["payload"] for e in evs}
    assert set(by_kind) == {"memory", "workflow", "agent_report", "research_doc"}
    assert by_kind["memory"]["props"]["session"] == "11111111-aaaa-bbbb-cccc-222222222222"
    assert by_kind["workflow"]["props"]["session"] == "22222222-aaaa-bbbb-cccc-333333333333"
    assert by_kind["memory"]["title"] == "메모 제목 A" and by_kind["research_doc"]["title"] == "조사 문서 제목"
    # 세션 서술은 claim, entity, edge가 되지 않는다
    if mode == "open":
        assert kinds_in_ledger() <= {"record.put", "ticket.open", "ticket.update", "schema.type_defined",
                                     "schema.predicate_defined", "system.fp_opened"}


# ------------------------------------------------------------------ 멱등과 버전

def test_idempotent_rerun_writes_zero_events(world, mode):
    populate(world)
    world.doc("links.md", "# 링크 문서\n\n출처는 https://example.org/a 와 https://example.org/b 이다. 본문이 길다.\n")
    cfg = world.cfg()
    r1 = core.run(cfg)
    assert r1["new_events"] > 0 and r1["urls"]["registered"] == 2
    n_events, n_held, h1 = count_events(), len(held_files()), len(harvest_events())
    r2 = core.run(cfg)
    r3 = core.run(cfg)
    for r in (r2, r3):
        assert r["new_events"] == 0 and r["writes"]["events"] == 0
        assert r["actions"] == {"unchanged": 5} and r["urls"]["registered"] == 0
    assert count_events() == n_events and len(held_files()) == n_held and len(harvest_events()) == h1


def test_changed_content_adds_a_version_of_the_same_record(world, mode):
    p = world.memory(name="a.md", body="처음 본문\n")
    other = world.doc("keep.md", "# 그대로\n\n바뀌지 않는 문서 본문이다.\n")
    cfg = world.cfg()
    core.run(cfg)
    world.memory(name="a.md", body="바뀐 본문\n둘째 줄\n")
    r = core.run(cfg)
    assert r["actions"] == {"changed": 1, "unchanged": 1} and r["writes"]["events"] == 1
    mem = [e for e in harvest_events() if e["payload"]["props"]["source_kind"] == "memory"]
    assert len(mem) == 2 and len({e["subject"] for e in mem}) == 1                 # 새 기록이 아니라 같은 ID의 새 버전
    assert mem[0]["idem_key"].split(":")[2] == "v1" and mem[1]["idem_key"].split(":")[2] == "v2"
    if mode == "open":
        c = ledger.open_ledger()
        try:
            v, sha = ledger.record_head(c, mem[0]["subject"])
            assert v == 2 and "바뀐 본문" in ledger.get_payload(c, sha)["body"]
        finally:
            c.close()
    else:
        # 개방 뒤 보관분이 쓴 순서대로 적재돼 v1, v2가 된다
        from wrhelp import open_fp_direct
        from kb.write import fpgate
        open_fp_direct()
        assert fpgate.drain("fp-held") == {"loaded": 3, "failed": 0, "left": 0}      # 기록 2건 + 문서 1건
        c = ledger.open_ledger()
        try:
            v, sha = ledger.record_head(c, mem[0]["subject"])
            assert v == 2 and "바뀐 본문" in ledger.get_payload(c, sha)["body"]
        finally:
            c.close()


def test_touching_a_source_without_changing_it_writes_nothing(world, mode):
    p = world.memory(name="a.md", body="그대로인 본문 한 줄\n")
    cfg = world.cfg()
    core.run(cfg)
    os.utime(p, (OLD_PLUS, OLD_PLUS))
    r = core.run(cfg)
    assert r["actions"] == {"unchanged": 1} and r["new_events"] == 0


def test_reverting_to_older_content_is_a_new_version_not_a_replay(world, mode):
    cfg = world.cfg()
    world.memory(name="a.md", body="내용 A\n")
    core.run(cfg)
    world.memory(name="a.md", body="내용 B\n")
    core.run(cfg)
    world.memory(name="a.md", body="내용 A\n")
    r = core.run(cfg)
    assert r["actions"] == {"changed": 1} and r["writes"]["events"] == 1
    keys = [e["idem_key"].split(":")[2] for e in harvest_events()]
    assert keys == ["v1", "v2", "v3"]


def test_tombstoned_record_is_not_resurrected(world):
    from wrhelp import open_fp_direct
    from kb.write import tombstone_record
    open_fp_direct()
    world.memory(name="a.md", body="처음 본문\n")
    cfg = world.cfg()
    core.run(cfg)
    rid = harvest_events()[0]["subject"]
    tombstone_record(rid, "사용자가 지움", "tomb-1", "cli", tty=True)
    world.memory(name="a.md", body="바뀐 본문\n")
    r = core.run(cfg)
    assert r["actions"] == {"removed_by_user": 1} and r["new_events"] == 0 and len(harvest_events()) == 1


# ------------------------------------------------------------------ 비밀과 내부 주소

def test_secret_skips_the_whole_source_and_leaves_no_trace(world, mode):
    world.memory(name="ok.md", body="안전한 메모 본문 OK-SENTINEL\n")
    world.memory(name="leak.md", body=f"CLEAN-LINE-SENTINEL 앞 줄\ntoken = {FAKE_PAT}\n뒷 줄\n")
    world.journal([("research:x", {"summary": f"결과 요약이다. 키는 {FAKE_PAT} 였다. " + "문장 " * 20})], wf="wf_leak")
    world.agent(f"보고서다. {FAKE_PAT} 포함. " + "문장 " * 40, agent_id="aleak")
    world.doc("leak.md", f"# 문서\n\nPASSWORD_HEADER\nexport API_TOKEN={FAKE_PAT}\n")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 1 and rep["skipped"] == {"secret": 4}
    assert rep["actions"] == {"new": 1} and rep["skipped_secret_rules"]
    assert all(isinstance(k, str) and FAKE_PAT not in k for k in rep["skipped_secret_rules"])
    blob = all_bytes(world.home.parent)
    assert FAKE_PAT.encode() not in blob and b"CLEAN-LINE-SENTINEL" not in blob       # 원본을 통째로 건너뛴다
    assert b"OK-SENTINEL" in blob
    assert FAKE_PAT not in str(rep)
    pj = rep["projects"]["proj-a"]
    assert pj["skipped_secret"] == 3 and rep["projects"]["sagae-demo"]["skipped_secret"] == 1


def test_secret_on_a_line_the_scrubber_would_drop_still_skips_the_source(world, mode):
    # 줄 정화가 그 줄을 먼저 지워도 비밀이 있던 원본이다. 원문에 먼저 탐지를 걸어 원본을 통째로 건너뛴다
    world.memory(name="mixed.md", body=f"ssh 192.0.2.1 --token {FAKE_PAT}\nKEEP-LINE-SENTINEL 안전한 줄이다\n")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 0 and rep["skipped"] == {"secret": 1} and not harvest_events()
    assert b"KEEP-LINE-SENTINEL" not in all_bytes(world.home.parent)


def test_secret_in_title_skips_the_source(world):
    world.memory(name="t.md", desc=f"제목에 {FAKE_PAT}", body="본문 정상\n")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 0 and rep["skipped"] == {"secret": 1}


def test_internal_addresses_hostnames_and_token_scopes_are_removed(world, mode):
    world.memory(name="net.md", desc="네트워크 메모", body="\n".join([
        "KEEP-1 공개 설명", "사설 192.0.2.1 접속", f"노드 {NODE} 에서 실측", "내부 host.internal 확인", "scopes: repo, admin:org",
        "localhost:8080 사용", "차단 대역 10.x.x.x 와 192.168.x.x", "tailnet 100.64.2.3", "fe80::1 링크", "KEEP-2 공개 설명", ""]))
    rep = core.run(world.cfg())
    assert rep["lines_removed"] == 8 and rep["verify"]["deny_hits"] == rep["verify"]["internal_addr_hits"] == 0
    (e,) = harvest_events()
    assert e["payload"]["body"] == "KEEP-1 공개 설명\nKEEP-2 공개 설명\n" and e["payload"]["props"]["scrubbed_lines"] == 8
    blob = all_bytes(world.home.parent)
    for bad in (b"192.0.2.1", NODE.encode(), b"host.internal", b"admin:org", b"localhost:8080", b"100.64.2.3", b"fe80::1"):
        assert bad not in blob, bad


def test_stored_records_pass_the_intake_style_verification(world, mode):
    populate(world)
    world.memory(name="net.md", body=f"공개 줄은 이렇게 충분히 길게 쓴다\n{NODE} 노드\n10.x.x.x 주소\n")
    core.run(world.cfg())
    sc = scrubber()
    for e in harvest_events():
        p = e["payload"]
        text = "\n".join([p["title"], p["body"], str(p["props"])])
        assert filters.audit_total(sc.audit(text)) == 0 and not filters.secret_rules(text)


def test_source_with_only_removed_lines_is_not_stored(world):
    world.memory(name="only.md", body="192.168.x.x\n10.x.x.x\n")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 0 and rep["skipped"] == {"empty": 1} and not harvest_events()


# ------------------------------------------------------------------ 상한

def test_write_count_cap_defers_the_rest_to_later_runs(world, mode):
    for i in range(5):
        world.memory(name=f"m{i}.md", body=f"본문 {i} 번 메모\n", desc=f"메모 {i}")
    cfg = world.cfg(max_writes=2)
    seen = []
    for _ in range(4):
        r = core.run(cfg)
        seen.append((r["writes"]["events"], r["deferred"].get("cap", 0)))
    assert seen == [(2, 3), (2, 1), (1, 0), (0, 0)]
    assert len({e["subject"] for e in harvest_events()}) == 5


def test_write_bytes_cap_holds(world, mode):
    for i in range(3):
        world.memory(name=f"m{i}.md", body=("가" * 200 + "\n") * 5, desc=f"메모 {i}")           # 약 3 KB
    cfg = world.cfg(max_body_bytes=4000, max_write_bytes=4500)
    r = core.run(cfg)
    assert r["writes"]["events"] == 1 and r["writes"]["bytes"] <= 4500 and r["deferred"] == {"cap": 2}


def test_body_size_cap_truncates_on_a_line_boundary(world, mode):
    lines = [f"줄 {i:04d} 가나다라마바사" for i in range(1000)]
    world.doc("big.md", "# 큰 문서\n\n" + "\n".join(lines) + "\n")
    cfg = world.cfg(max_body_bytes=5000)
    rep = core.run(cfg)
    (e,) = harvest_events()
    body = e["payload"]["body"]
    assert len(body.encode()) <= 5000 and body.endswith("\n") and e["payload"]["props"]["truncated"] is True
    assert body.splitlines()[-1] in lines
    assert core.run(cfg)["new_events"] == 0                                        # 잘린 기록도 멱등이다


def test_source_count_cap(world):
    for i in range(5):
        world.memory(name=f"m{i}.md", body=f"본문 {i}\n")
    rep = core.plan(world.cfg(max_sources=2))
    assert rep["candidates"] == 2 and rep["sources"]["capped"] == 3


def test_fresh_sources_are_deferred_not_stored(world):
    import time
    world.memory(name="fresh.md", body="방금 고친 메모\n", mtime=time.time() - 5)
    world.memory(name="old.md", body="오래된 메모\n")
    rep = core.run(world.cfg(min_age_s=600))
    assert rep["candidates"] == 1 and rep["skipped"] == {"too_new": 1}


# ------------------------------------------------------------------ URL과 티켓

def test_urls_become_deduplicated_public_tickets_only(world, mode):
    world.doc("a.md", "\n".join([
        "# 문서 A", "", "공개 출처 https://example.org/docs/a?utm_source=x&id=7#frag 참고",
        "같은 주소 https://example.org/docs/a?id=7 다시", "또 https://example.net/b 와 https://example.com/c",
        "사설 https://10.x.x.x/x 는 줄째 빠진다", "내부 https://svc.internal/y 도", "계정 https://user:pw@example.org/z",
        "비밀 쿼리 https://example.org/p?access_token=abc", "http는 제외 http://example.org/plain", ""]))
    world.memory(name="b.md", body="다른 원본의 같은 출처 https://example.com/c 와 새 출처 https://example.org/new\n")
    rep = core.run(world.cfg())
    urls = {u for r in ticket._open_rows() for u in r["urls"]}
    assert urls == {"https://example.org/docs/a?id=7", "https://example.net/b", "https://example.com/c",
                    "https://example.org/new"}
    assert rep["urls"]["registered"] == 4 and rep["tickets"] >= 1
    assert all(r["topic"].startswith("세션 수확 출처 재확인: ") for r in ticket._open_rows())
    ev = [e for e in _ledger_events() if e["kind"].startswith("ticket.")]
    assert ev and all(e["actor"] == "agent:harvest" and e["on_behalf_of"] == "user:sagae" for e in ev)


def _ledger_events():
    c = ledger.open_ledger()
    try:
        return ledger.iter_events(c, 0, 100000)
    finally:
        c.close()


def test_urls_with_email_like_query_values_never_reach_a_ticket(world):
    world.doc("a.md", "\n".join([
        "# 문서", "", "프로필 https://example.org/profile?email=me@example.com 은 이메일 줄이라 줄째 빠진다",
        "인코딩된 https://example.org/p?u=me%40example.com 은 URL 규칙이 거른다",
        "패키지 https://www.npmjs.com/package/@scope/pkg 는 경로의 @라 괜찮다", ""]))
    r = core.run(world.cfg())
    assert {u for t in ticket._open_rows() for u in t["urls"]} == {"https://www.npmjs.com/package/@scope/pkg"}
    assert r["urls"]["registered"] == 1 and r["urls"]["skipped"] >= 1 and r["lines_removed"] == 1
    from kb.harvest import tickets
    assert tickets._personal_query("https://example.org/p?x=a@b.c") and not tickets._personal_query("https://x.org/@a/b?q=1")


def test_closed_tickets_are_not_reopened_on_later_runs(world):
    world.doc("a.md", "# 문서\n\n출처 https://example.org/one 와 https://example.net/two 이다. 본문은 충분히 길다.\n")
    cfg = world.cfg()
    r1 = core.run(cfg)
    assert r1["urls"]["registered"] == 2
    for row in ticket._open_rows():
        ticket.close_ticket(row["id"], "done", "확인함")
    assert ticket._open_rows() == []
    r2 = core.run(cfg)
    assert r2["urls"]["registered"] == 0 and r2["urls"]["known"] == 2 and r2["new_events"] == 0
    assert ticket._open_rows() == []


def test_url_caps_per_source_and_per_run_are_counted_and_resumed(world):
    urls = [f"https://example.org/p{i:02d}" for i in range(30)]
    world.doc("many.md", "# 많은 링크\n\n" + "\n".join(f"- {u}" for u in urls) + "\n")
    r1 = core.run(world.cfg(max_urls_per_source=12, max_urls=5))
    assert r1["urls"]["registered"] == 5 and r1["urls"]["capped_source"] == 18 and r1["urls"]["capped_run"] == 7
    got = {u for r in ticket._open_rows() for u in r["urls"]}
    assert len(got) == 5 and got <= set(urls)
    r2 = core.run(world.cfg(max_urls_per_source=12, max_urls=5))             # 이어서 올린다
    got2 = {u for r in ticket._open_rows() for u in r["urls"]}
    assert r2["urls"]["registered"] == 5 and len(got2) == 10 and got <= got2


def test_ticket_url_limit_per_ticket_is_counted(world, monkeypatch):
    monkeypatch.setattr(ticket, "MAX_URLS", 2)
    world.doc("many.md", "# 링크\n\n" + "\n".join(f"- https://example.org/q{i}" for i in range(6)) + "\n")
    r = core.run(world.cfg())
    assert r["urls"]["registered"] == 2 and r["urls"]["capped_ticket"] == 4


# ------------------------------------------------------------------ dry-run

def test_dry_run_reads_everything_and_writes_nothing(world, mode):
    populate(world)
    world.doc("links.md", "# 링크\n\n출처 https://example.org/a 이다. 본문이 충분히 길다.\n")
    before = tree(world.home.parent)
    ledger_existed = ledger.ledger_path().exists()
    rep = core.plan(world.cfg(), dump_dir=str(world.home.parent / "dump"))
    assert rep["mode"] == "dry-run" and rep["candidates"] == 5 and rep["writes"]["events"] == 0
    assert rep["actions"] == {"new": 5} and rep["urls"]["registered"] == 1 and rep["new_events"] == 0
    after = tree(world.home.parent)
    added = {k for k in after if k not in before}
    assert all(k.startswith("dump/") for k in added)                 # 덤프 외에 늘어난 파일이 없다
    assert {k: v for k, v in after.items() if not k.startswith("dump/")} == before
    assert ledger.ledger_path().exists() == ledger_existed           # 원장을 새로 만들지 않는다
    assert not held_files() and not harvest_events()


def test_dry_run_on_a_stored_kb_reports_unchanged_and_still_writes_nothing(world, mode):
    populate(world)
    core.run(world.cfg())
    before = tree(world.home.parent)
    rep = core.plan(world.cfg())
    assert rep["actions"] == {"unchanged": 4} and rep["new_events"] == 0
    assert tree(world.home.parent) == before


def test_dry_run_dump_and_sample_have_no_deny_hits_and_titles_only(world):
    populate(world)
    world.memory(name="net.md", desc="내부 메모", body=f"공개 줄은 이렇게 충분히 길게 쓴다\n{NODE} 노드\n10.x.x.x 주소\n192.168.x.x 대역\n")
    out = world.home.parent / "dump"
    rep = core.plan(world.cfg(), samples=3, dump_dir=str(out))
    assert len(rep["samples"]) == 3 and all(set(s) == {"kind", "project", "title", "action"} for s in rep["samples"])
    assert rep["verify"] == {"records": 5, "deny_hits": 0, "internal_addr_hits": 0, "email_hits": 0, "extra_hits": 0,
                             "secret_hits": 0}
    sc = scrubber()
    files = sorted(out.glob("*.md"))
    assert len(files) == 5
    for f in files:
        text = f.read_text(encoding="utf-8")
        assert filters.audit_total(sc.audit(text)) == 0 and NODE not in text and (f.stat().st_mode & 0o777) == 0o600


def test_per_project_counts_in_the_report(world):
    world.memory(project="-home-u-proj-a", name="a.md", body="메모 하나의 본문은 충분히 길다\n192.168.x.x\n")
    world.memory(project="-home-u-proj-b", name="b.md", body="메모 둘의 본문도 충분히 길다\n")
    world.memory(project="-home-u-proj-b", name="leak.md", body=f"x {FAKE_PAT}\n")
    world.doc("d.md", "# 문서\n\n출처 https://example.org/z 와 https://example.org/y 이다. 본문이 충분히 길다.\n")
    rep = core.plan(world.cfg())
    assert rep["projects"]["proj-a"] == {"sources": 1, "candidates": 1, "skipped_secret": 0, "skipped_other": 0,
                                        "lines_removed": 1, "urls_found": 0, "new": 1, "changed": 0, "unchanged": 0,
                                        "deferred": 0}
    assert rep["projects"]["proj-b"]["skipped_secret"] == 1 and rep["projects"]["proj-b"]["candidates"] == 1
    assert rep["projects"]["sagae-demo"]["urls_found"] == 2


# ------------------------------------------------------------------ 안전 장치

def test_deny_list_is_required(world):
    (world.cfg_dir / "intake-deny.txt").unlink()
    from kb.intake.errors import IntakeError
    with pytest.raises(IntakeError) as ei:
        core.plan(world.cfg())
    assert ei.value.code == "E_DENY_MISSING"


def test_overlapping_runs_are_refused_by_the_lock(world):
    from kb.core import paths
    from kb.core.gatelock import Gate
    world.memory()
    g = Gate(paths.ops_dir() / "harvest.lock")
    fd = g.acquire(1.0)
    try:
        r = core.run(world.cfg())
    finally:
        g.release(fd)
    assert r["skipped"] == "locked" and not harvest_events()
    assert core.run(world.cfg())["actions"] == {"new": 1}


def test_write_rejection_is_counted_and_does_not_stop_the_run(world, monkeypatch):
    world.memory(name="a.md", body="본문 가\n")
    world.memory(name="b.md", body="본문 나\n")
    from kb.write import WriteRejected
    import kb.write as kw
    real = kw.put_record
    calls = []

    def flaky(rec, key, transport, session=None, **k):
        calls.append(key)
        if len(calls) == 1:
            raise WriteRejected("schema_invalid", "시험")
        return real(rec, key, transport, session=session, **k)
    monkeypatch.setattr(kw, "put_record", flaky)
    r = core.run(world.cfg())
    assert r["writes"]["errors"] == {"schema_invalid": 1} and len(harvest_events()) == 1
    monkeypatch.setattr(kw, "put_record", real)
    assert core.run(world.cfg())["actions"] == {"new": 1, "unchanged": 1}           # 거부된 것은 다음 실행이 잇는다


def test_url_stage_fails_closed_when_ticket_history_is_unreadable(world, monkeypatch):
    from kb.harvest import tickets
    world.doc("a.md", "# 문서\n\n출처 https://example.org/one 이다. 본문은 충분히 길다.\n")

    real = tickets.ticketed_urls

    def boom():
        raise RuntimeError("gold 읽기 실패")
    monkeypatch.setattr(tickets, "ticketed_urls", boom)
    r = core.run(world.cfg())
    assert r["urls"]["aborted"] == "RuntimeError" and r["urls"]["registered"] == 0 and r["urls"]["errors"] == 1
    assert ticket._open_rows() == []                       # 이력을 모르면 올리지 않는다
    assert r["actions"] == {"new": 1}                      # 기록 쓰기는 영향이 없다
    monkeypatch.setattr(tickets, "ticketed_urls", real)
    assert core.run(world.cfg())["urls"]["registered"] == 1  # 다음 실행이 잇는다


# ------------------------------------------------------------------ 이메일, 앞부분 토큰, user 메모리, git SHA

def test_email_lines_are_removed_from_stored_records(world, mode):
    world.memory(name="mail.md", body="\n".join([
        "KEEP-1 공개 설명", "문의는 user@example.com 로 한다", "Co-Authored-By: Claude <noreply@anthropic.com>",
        "개인 메일 someone.private@gmail.com 포함", "typescript@5.9.3 은 이메일이 아니다", "KEEP-2 공개 설명", ""]))
    rep = core.run(world.cfg())
    assert rep["lines_removed"] == 3 and rep["verify"]["email_hits"] == 0
    (e,) = harvest_events()
    assert e["payload"]["body"] == "KEEP-1 공개 설명\ntypescript@5.9.3 은 이메일이 아니다\nKEEP-2 공개 설명\n"
    blob = all_bytes(world.home.parent)
    for bad in (b"user@example.com", b"someone.private@gmail.com", b"noreply@anthropic.com"):
        assert bad not in blob, bad


def test_partial_node_tokens_are_removed_in_the_pipeline(world, mode):
    deny = world.cfg_dir / "intake-deny.txt"
    deny.write_text(f"{NODE}\nzzqq-4242\nzzqq-4243p1\nclusterzz-main\n", encoding="utf-8")
    world.memory(name="n.md", body="\n".join(["KEEP-1 공개 설명", "새 노드 zzqq-9999 를 더했다", "clusterzz-main 상태", "KEEP-2 공개 설명", ""]))
    rep = core.run(world.cfg())
    assert rep["filters"] == {"deny_entries": 4, "deny_stems": 1} and rep["lines_removed"] == 2
    (e,) = harvest_events()
    assert e["payload"]["body"] == "KEEP-1 공개 설명\nKEEP-2 공개 설명\n"
    assert b"zzqq-" not in all_bytes(world.home.parent) and b"clusterzz" not in all_bytes(world.home.parent)


def test_user_type_memories_are_excluded_entirely(world, mode):
    world.memory(name="u1.md", typ="user", body="USER-PROFILE-SENTINEL 하나\n")
    world.memory(name="u2.md", typ="User", body="USER-PROFILE-SENTINEL 둘\n")
    for t in ("feedback", "project", "reference"):
        world.memory(name=f"{t}.md", typ=t, body=f"{t} 메모 본문이다\n", desc=f"{t} 제목")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 3 and rep["skipped"] == {"excluded_memory_type": 2}
    assert {e["payload"]["props"]["memory_type"] for e in harvest_events()} == {"feedback", "project", "reference"}
    assert b"USER-PROFILE-SENTINEL" not in all_bytes(world.home.parent)
    # 설정으로 바꿀 수 있다
    rep2 = core.plan(world.cfg(exclude_memory_types=()))
    assert rep2["candidates"] == 5


SHA_J = "0123456789abcdef0123456789abcdef01234567"
SHA_K = "fedcba9876543210fedcba9876543210fedcba98"


def test_git_sha_lines_do_not_skip_the_source_and_are_not_quarantined(world, mode):
    world.journal([("git:rebase", {"summary": "리베이스 결과다.\nTIP=" + SHA_J + "\nBASE=" + SHA_K + "\n둘 다 로컬 커밋이다. 충분히 긴 문장."})])
    rep = core.run(world.cfg())
    assert rep["candidates"] == 1 and rep["skipped"] == {} and rep["git_sha_values_shortened"] == 2
    assert rep["writes"]["secret_hits"] == 0 and rep["actions"] == {"new": 1}
    (e,) = harvest_events()
    p = e["payload"]
    assert p["sensitivity"] == "internal" and "quarantine" not in p["props"]          # 쓰기 코어의 자체 탐지도 같은 판정이다
    assert f"TIP={SHA_J[:12]}…" in p["body"] and f"BASE={SHA_K[:12]}…" in p["body"]
    blob = all_bytes(world.home.parent)
    assert SHA_J.encode() not in blob and SHA_K.encode() not in blob                   # 40자리 전체는 어디에도 남지 않는다
    assert core.run(world.cfg())["new_events"] == 0                                    # 줄인 값으로도 멱등이다


@pytest.mark.parametrize("line", [
    "SOME_VALUE=aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k",       # 16진수가 아닌 고엔트로피 값
    "TIP=aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k",              # 키가 SHA 같아도 값이 SHA가 아니다
    f"API_TOKEN={SHA_J}",                                        # 비밀스러운 키 이름
    f"TIP={SHA_J}{SHA_K[:24]}",                                  # 64자리
    f"TIP={SHA_J.upper()}",                                      # 대문자
])
def test_real_high_entropy_values_still_skip_the_source(world, mode, line):
    world.memory(name="v.md", body=f"KEEP-LINE-SENTINEL 앞 줄\n{line}\n뒷 줄\n")
    rep = core.run(world.cfg())
    assert rep["candidates"] == 0 and rep["skipped"] == {"secret": 1} and "kb-env-high-entropy" in rep["skipped_secret_rules"]
    assert not harvest_events() and b"KEEP-LINE-SENTINEL" not in all_bytes(world.home.parent)
