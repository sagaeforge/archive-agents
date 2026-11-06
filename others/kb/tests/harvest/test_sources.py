import os

import pytest

from kb.harvest import sources
from kb.harvest.sources import SkipSource


def extract(world, path, **cfg):
    c = world.cfg(**cfg)
    found, _ = sources.discover(c)
    (src,) = [s for s in found if s.path == path]
    sources.check_age(src, c)
    return sources.extract(src, c)


def kinds(world, **cfg):
    found, st = sources.discover(world.cfg(**cfg))
    return sorted((s.kind, s.project) for s in found), st


def test_memory_frontmatter_title_session_date_and_index_excluded(world):
    p = world.memory(name="a.md", desc="결정은 질문 도구로 묻는다", typ="feedback", body="본문\n")
    world.memory(name="MEMORY.md", body="- [x](a.md) — 색인\n")
    e = extract(world, p)
    assert e.title == "결정은 질문 도구로 묻는다" and e.text == "본문\n"
    assert e.date == "2026-10-31" and e.session == "11111111-aaaa-bbbb-cccc-222222222222"
    assert e.props == {"memory_type": "feedback", "memory_name": "a"}
    k, _ = kinds(world)
    assert k == [("memory", "proj-a")]            # MEMORY.md는 색인이라 뺀다


def test_memory_without_frontmatter_uses_heading(world):
    p = world.projects / "-home-u-proj-a" / "memory" / "raw.md"
    p.parent.mkdir(parents=True)
    p.write_text("# 제목 줄\n\n본문\n", encoding="utf-8")
    e = extract(world, p)
    assert e.title == "제목 줄" and "본문" in e.text


def test_workflow_uses_report_summaries_not_json_dumps(world):
    p = world.journal([
        ("research:a", {"summary": "첫째 결론이다. 근거는 표 3개." * 3, "status": "done", "acceptance": [{"criterion": "ACCEPT-NOISE", "passed": True}],
                        "changed_paths": ["CHANGED-PATH-NOISE"], "risks": ["위험 하나", {"text": "위험 둘"}, {"unknown_key": "SKIP"}]}),
        ("verify:b", "문자열 결과도 그대로 싣는다. " * 4),
        ("tiny", "n3"),                                         # 시험용 한 단어 결과
        ("no-summary", {"findings": ["찾은 것 하나가 여기 있다", "찾은 것 둘"], "verdict": "partial"}),
    ])
    e = extract(world, p)
    assert e.title.startswith("워크플로우 결과: research:a 외 2건 (wf_demo1234)")
    for noise in ("ACCEPT-NOISE", "CHANGED-PATH-NOISE", "SKIP", "{", "toolsUsed", "acceptance"):
        assert noise not in e.text
    assert "## research:a" in e.text and "- status: done" in e.text and "  - 위험 둘" in e.text
    assert "## tiny" not in e.text and "- verdict: partial" in e.text and "  - 찾은 것 둘" in e.text
    assert e.session == "22222222-aaaa-bbbb-cccc-333333333333"


def test_workflow_without_report_text_is_skipped(world):
    p = world.journal([("n1", "n1"), ("n2", {"wp": "x"})])
    with pytest.raises(SkipSource) as ei:
        extract(world, p)
    assert ei.value.reason == "not_report"


def test_workflow_result_lists_are_bounded(world):
    p = world.journal([("big", {"summary": "요약 문장이 길게 이어진다. " * 5, "risks": [f"항목 {i}" + "가" * 400 for i in range(30)]})])
    e = extract(world, p)
    items = [ln for ln in e.text.splitlines() if ln.startswith("  - ")]
    assert len(items) == sources.MAX_LIST_ITEMS and all(len(i) <= sources.MAX_ITEM_CHARS + 4 for i in items)


def test_agent_report_is_last_text_of_finished_agent_only(world):
    p = world.agent("최종 보고: 결과는 다음과 같다. " * 10, description="Map contract onto loupe")
    e = extract(world, p)
    assert e.title == "Map contract onto loupe" and e.text.startswith("최종 보고") and "thinking" not in e.text
    assert e.date == "2026-10-31" and e.props["agent_type"] == "general-purpose"


@pytest.mark.parametrize("kw,reason", [
    (dict(finished=False), "unfinished"),                       # meta.finished가 참이 아니다
    (dict(stop="tool_use"), "unfinished"),                      # 마지막이 도구 호출이다
    (dict(agent_type="team-watcher"), "excluded_type"),
    (dict(text="짧다"), "not_report"),                          # 길이 거름
    (dict(text="가" * 30000), "not_report"),
])
def test_agent_report_filters(world, kw, reason):
    args = dict(text="보고서 본문이다. " * 30)
    args.update(kw)
    p = world.agent(**args)
    with pytest.raises(SkipSource) as ei:
        extract(world, p)
    assert ei.value.reason == reason


def test_agent_report_reads_only_the_tail_of_a_big_transcript(world):
    p = world.agent("끝에서 읽은 보고서다. " * 20, pad=3000)       # 앞쪽이 매우 큰 전사
    assert p.stat().st_size > 400_000
    e = extract(world, p, transcript_tail_bytes=100_000)
    assert e.text.startswith("끝에서 읽은 보고서다.")


def test_research_docs_only_from_git_checkouts(world):
    world.doc("a.md", "# 조사 A\n본문\n")
    world.doc("b.txt", "무시")
    other = world.home / "sagae-nogit"
    (other / "docs" / "research").mkdir(parents=True)
    (other / "docs" / "research" / "c.md").write_text("# C\n", encoding="utf-8")
    k, _ = kinds(world)
    assert k == [("research_doc", "sagae-demo")]


def test_scratchpad_and_test_projects_are_excluded_before_opening(world):
    world.memory(project="-home-u-proj-a")
    world.memory(project="-tmp-claude-1000--home-u-proj-a-abc-scratchpad-x")
    world.memory(project="-home-u--cache-sagae-kb-build-WP-09-test-tmp-contract")
    world.memory(project="-tmp-claude-setup")                           # 숫자가 없는 /tmp 프로젝트는 진짜 프로젝트다
    k, st = kinds(world)
    assert k == [("memory", "proj-a"), ("memory", "tmp-claude-setup")]
    assert st["excluded_projects"] == 2


def test_symlinked_and_oversized_sources_are_not_read(world):
    real = world.memory(name="real.md")
    link = real.parent / "link.md"
    link.symlink_to(real)
    big = world.memory(name="big.md", body="x\n" * 10_000)
    c = world.cfg(max_read_bytes=1000)
    found, _ = sources.discover(c)
    assert sorted(s.path.name for s in found) == ["big.md", "real.md"]           # 심볼릭 링크는 발견하지 않는다
    (src,) = [s for s in found if s.path == big]
    with pytest.raises(SkipSource) as ei:
        sources.extract(src, c)
    assert ei.value.reason == "too_large"


def test_age_gate(world, monkeypatch):
    import time
    p = world.memory(mtime=time.time() - 10)
    c = world.cfg(min_age_s=600)
    (src,) = [s for s in sources.discover(c)[0] if s.path == p]
    with pytest.raises(SkipSource) as ei:
        sources.check_age(src, c)
    assert ei.value.reason == "too_new"


def test_project_name():
    assert sources.project_name("-home-sagae-sagae-tools") == "sagae-tools"
    assert sources.project_name("-mnt-c-Users-sagae") == "mnt-c-Users-sagae"
    assert sources.project_name("-tmp-claude-setup") == "tmp-claude-setup"


@pytest.mark.parametrize("typ,kept", [("user", False), ("USER", False), ("feedback", True), ("project", True), ("reference", True)])
def test_memory_type_user_is_excluded_others_stay(world, typ, kept):
    p = world.memory(name="m.md", typ=typ, body="본문\n")
    if kept:
        assert extract(world, p).props["memory_type"] == typ
    else:
        with pytest.raises(SkipSource) as ei:
            extract(world, p)
        assert ei.value.reason == "excluded_memory_type"


def test_memory_without_a_type_is_kept_and_the_exclusion_is_configurable(world):
    p = world.projects / "-home-u-proj-a" / "memory" / "plain.md"
    p.parent.mkdir(parents=True)
    p.write_text("---\nname: plain\ndescription: 타입 없음\n---\n\n본문\n", encoding="utf-8")
    assert extract(world, p).title == "타입 없음"
    q = world.memory(name="u.md", typ="user")
    assert extract(world, q, exclude_memory_types=()).props["memory_type"] == "user"
