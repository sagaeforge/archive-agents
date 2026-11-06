"""sources-inventory-g 3.5 표본 사례를 규칙으로 옮긴 시험(순수 함수, 네트워크 없음)."""
from kb.live import rules, signals as S
from kb.live.model import Sig

NOW = 1_800_000_000_000


def sigs_of(*xs):
    return [x for x in xs if x]


def test_archived_alone_is_not_removed():
    d = rules.decide("e:repo:a-b", "repo", [S.m01_archived({"archived": True}, "n-1")])
    assert d.liveness == "stale_suspect" and d.status == "active"
    assert d.queue and d.queue[0].question == "H02" and d.queue[0].proposed == "removed"


def test_readme_successor_makes_repo_superseded_and_rechecks_project():
    readme = "# gsd\n\nThis repository has been archived. Moved to open-gsd/gsd-core.\n"
    sg = sigs_of(S.m01_archived({"archived": True}, "n-1"), S.m05_readme(readme, "gsd-build/get-shit-done", "n-2"))
    d = rules.decide("e:repo:gsd-build-get-shit-done", "repo", sg)
    assert (d.liveness, d.status, d.successor) == ("superseded", "superseded", "open-gsd/gsd-core")
    assert d.recheck and d.recheck[0]["unit"] == "project" and d.recheck[0]["target"] == "open-gsd/gsd-core"


def test_readme_without_successor_is_deprecated_with_human_question():
    sg = [S.m05_readme("# x\n\nThis project is no longer maintained.\n", "a/b", "n-1")]
    d = rules.decide("e:repo:a-b", "repo", sg)
    assert d.liveness == "deprecated" and d.queue[0].proposed == "removed"


def test_readme_archived_server_list_is_not_a_declaration():
    text = "# Servers\n\n## Archived servers\n\n- [pg](u) - deprecated postgres server\n- [slack](u) - archived\n"
    assert S.m05_readme(text, "modelcontextprotocol/servers") is None
    fence = "# T\n\n```\nThis project is deprecated\n```\n"
    assert S.m05_readme(fence, "a/b") is None


def test_changelog_removed_ui_cleanup_is_excluded():
    cl = ("## 2.1.92\n- Removed `/ultraplan` command\n"
          "- Removed the `/ultraplan` hint text from the footer\n"
          "- Removed the (research preview) label from the `/fast` dialog\n")
    c = S.m16_changelog(cl, "/ultraplan")
    assert len(c) == 1 and c[0].data["version"] == "2.1.92" and c[0].data["verb"] == "removed"
    assert [x.kind for x in S.m16_changelog(cl, "/fast")] == ["info"]


def test_not_sooner_than_is_not_a_retirement_date():
    row = "| claude-haiku-4-5-20251001 | Active | Not sooner than 2026-10-15 |"
    s = S.m20_model_table(row, "claude-haiku-4-5-20251001", NOW)
    assert s.kind == "info" and s.data["not_sooner_than"]
    d = rules.decide("e:model:haiku", "model", [s], current="alive")
    assert d.liveness == "alive" and not d.changed
    fut = S.m20_model_table("| claude-sonnet-4-5-20250929 | Deprecated | 2027-11-30 |", "claude-sonnet-4-5-20250929", NOW)
    d2 = rules.decide("e:model:sonnet", "model", [fut], current="alive")
    assert d2.liveness == "scheduled_removal" and d2.removal_date == "2027-11-30" and d2.status == "active"


def test_move_chain_follows_to_canonical_and_stops_on_cycle():
    nxt = {"glittercowboy/gsd": "gsd-build/get-shit-done", "gsd-build/get-shit-done": "open-gsd/gsd-core", "open-gsd/gsd-core": "glittercowboy/gsd"}
    chain = rules.canonical_chain("glittercowboy/gsd", nxt.get)
    assert chain == ["glittercowboy/gsd", "gsd-build/get-shit-done", "open-gsd/gsd-core"]
    m = S.m02_renamed({"full_name": chain[-1]}, chain[0], "n-1")
    d = rules.decide("e:repo:x", "repo", [m])
    assert d.liveness == "renamed" and d.canonical == "open-gsd/gsd-core" and d.status == "active"


def test_tombstone_needs_cross_check_to_remove():
    tomb = S.m12_tombstone("ultraplan is no longer available", "", "n-1")
    d = rules.decide("e:feature:ultraplan", "feature", [tomb], current="alive")
    assert d.liveness == "alive" and not d.auto and d.queue[0].proposed == "removed"
    cand = S.m16_changelog("## 2.1.9\n- Removed `ultraplan`\n", "ultraplan", "n-2")
    d2 = rules.decide("e:feature:ultraplan", "feature", [tomb] + cand, current="alive")
    assert d2.liveness == "removed" and d2.auto and d2.status == "dead"


def test_status_row_plus_changelog_removes_with_version_and_condition():
    row = S.m14_status_row("| `/vim` | Removed in v2.1.92 |\n", "/vim", "n-1")
    assert row.kind == "removed" and row.data["version"] == "2.1.92"
    cl = S.m16_changelog("## 2.1.92\n- Removed `/vim` command\n", "/vim", "n-2")
    assert rules.decide("e:feature:vim", "feature", [row] + cl).liveness == "removed"


def test_conditions_make_partial():
    row = S.m14_status_row("| 1M context | Removed on Max plans for Sonnet 4.5 |", "1M context", "n-1")
    d = rules.decide("e:feature:1m", "feature", [row])
    assert d.liveness == "partial" and d.conditions and d.status == "active"


def test_silence_stops_at_stale_suspect():
    old = {"pushed_at": "2025-01-01T00:00:00Z", "archived": False}
    m = S.m04_commit_age(old, NOW, "n-1")
    d = rules.decide("e:repo:z", "repo", [m, S.m09_publish_age("2024-08-14", NOW, "n-2")])
    assert d.liveness == "stale_suspect" and d.status == "active" and d.queue[0].question == "H04"


def test_npm_latest_deprecated_only():
    live = {"dist-tags": {"latest": "2"}, "versions": {"1": {"deprecated": "old"}, "2": {}}}
    assert S.m06_npm_deprecated(live) is None
    dep = {"dist-tags": {"latest": "2"}, "versions": {"2": {"deprecated": "please use @new/pkg instead going forward"}}}
    s = S.m06_npm_deprecated(dep, "n-1")
    d = rules.decide("e:package:p", "package", [s])
    assert d.liveness == "superseded" and d.successor == "@new/pkg"


def test_technique_is_never_automatic():
    d = rules.decide("e:technique:todo", "technique", [Sig("DEP", "removed", "n-1", "TodoWrite removed")], current="alive")
    assert not d.auto and d.queue[0].question == "H05" and d.liveness == "alive"


def test_revival_is_a_human_candidate():
    m17 = S.m17_reversal("## 2.1.154\n- Restored `/simplify` command\n", "/simplify", "n-1")
    d = rules.decide("e:feature:simplify", "feature", [m17], current="removed")
    assert d.liveness == "revived" and not d.auto and d.queue[0].question == "H07"
