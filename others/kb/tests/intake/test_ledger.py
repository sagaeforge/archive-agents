"""대장 docs/intake/session-research.md 의 모든 행과 파일이 매니페스트에 있고 항목별 처리가 지시와 같은지 대조한다."""
import copy
import re
from pathlib import Path

import yaml

from kb.intake.manifest import TREATS, load_manifest

REPO = Path(__file__).resolve().parents[2]
LEDGER = (REPO / "docs/intake/session-research.md").read_text(encoding="utf-8")
EXPECTED = yaml.safe_load((Path(__file__).parent / "expected_treat.yaml").read_text(encoding="utf-8"))


def diff(man: dict, expected: dict) -> list[str]:
    """매니페스트의 행별 treat, exclude_lines, urls_file, select, git_show가 기대값과 다른 곳."""
    bad = []
    got = {it["id"]: it for it in man["items"]}
    for iid in sorted(set(expected) | set(got)):
        if iid not in got or iid not in expected:
            bad.append(f"{iid}: 한쪽에만 있음")
            continue
        it, ex = got[iid], expected[iid]
        if it["treat"] != ex["treat"]:
            bad.append(f"{iid}: treat {it['treat']} != {ex['treat']}")
        for k in ("exclude_lines", "select"):
            if it.get(k) != ex.get(k):
                bad.append(f"{iid}: {k}")
        if Path(it["urls_file"]).name != ex["urls_file"] if "urls_file" in it and "urls_file" in ex else ("urls_file" in it) != ("urls_file" in ex):
            bad.append(f"{iid}: urls_file")
        if ("git_show" in it) != bool(ex.get("git_show")):
            bad.append(f"{iid}: git_show")
    return bad


def tables():
    """(절 제목, [행의 셀 목록]) 대장의 표를 읽는다."""
    out, sec, rows = [], None, []
    for ln in LEDGER.splitlines() + ["## END"]:
        if ln.startswith("#"):
            if sec is not None:
                out.append((sec, rows))
            sec, rows = ln.lstrip("# ").strip(), []
        elif ln.startswith("|") and not re.match(r"^\|[-| ]+\|$", ln):
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if cells[0] not in ("경로", "파일", "자료", "세션"):
                rows.append(cells)
    return out


def base(token: str) -> str:
    t = token.strip("`")
    if t.startswith("git show"):
        t = t.split(":")[-1]
    return t.rstrip("/").split("/")[-1]


def test_manifest_matches_expected_per_row():
    man = load_manifest()
    assert diff(man, EXPECTED) == []
    assert all(it["treat"] in TREATS for it in man["items"])


def test_negative_sample_foundation_design_as_full_fails():
    man = copy.deepcopy(load_manifest())
    for it in man["items"]:
        if it["id"] == "cp0e-foundation-design":
            it["treat"] = "full"
    assert any("cp0e-foundation-design" in d for d in diff(man, EXPECTED))


def test_every_ledger_file_is_an_item():
    man = load_manifest()
    bases = set()
    for it in man["items"]:
        if it.get("path"):
            bases.add(Path(it["path"]).name)
        if it.get("git_show"):
            bases.add(Path(it["git_show"]["path"]).name)
    n = 0
    for sec, rows in tables():
        if sec in ("요청 현황", "제외", "처리 규칙"):
            continue
        for cells in rows:
            for tok in re.findall(r"`([^`]+)`", cells[0]):
                if tok.startswith("git show"):
                    tok = tok.split("`")[0]
                if "." not in base(tok) and not tok.endswith("/"):
                    continue
                if base(tok) == "docs-raw":
                    assert sum("/docs-raw/" in (it.get("path") or "") for it in man["items"]) == 11
                else:
                    assert base(tok) in bases, f"대장 파일이 매니페스트에 없음: {tok}"
                n += 1
    assert n >= 20
    # claude-setup-22 파일 표는 파일 이름만 적는다
    for sec, rows in tables():
        if sec == "claude-setup-22":
            for cells in rows:
                for tok in re.findall(r"`([^`]+)`", cells[0]):
                    assert tok in bases


def test_every_exclusion_row_and_file_is_an_excluded_item():
    man = load_manifest()
    ex = [it for it in man["items"] if it["treat"] == "excluded"]
    text = " ".join(it["topic"] for it in ex)
    sec = dict(tables())["제외"]
    assert len(sec) == 3
    toks = [t for cells in sec for t in re.findall(r"`([^`]+)`", cells[0])]
    assert len(toks) == 6 and all(t in text for t in toks)
    assert "스크래치패드" in text and len(ex) >= 3
    assert all(it.get("note") for it in ex)


def test_all_sessions_in_status_table_are_marked():
    man = load_manifest()
    sess = {s["id"]: s for s in man["sessions"]}
    rows = dict(tables())["요청 현황"]
    ids = [re.findall(r"`([^`]+)`", c[0])[0] for c in rows]
    assert len(ids) == 8 and set(ids) == set(sess)
    assert all(sess[i].get("status") and sess[i].get("reply") for i in ids)
    assert sess["claude-setup-b1"]["status"] == "not_delivered"


def test_ledger_notes_and_counts():
    man = load_manifest()
    by = {it["id"]: it for it in man["items"]}
    assert "우선" in by["tools-verify-viewer"]["note"] and "Adversarial review" in by["tools-spike-results"]["note"]
    assert by["tools-spike-results"].get("no_urls") is True
    assert all("출처 URL과 확인일이 기록돼 있지 않아" in by[i]["note"] for i in by if i.startswith("cs22-"))
    assert sum(i.startswith("cp0e-docs-") for i in by) == 11
    assert sum(i.startswith("cs22-") for i in by) == 8
    assert sum(i.startswith("tools-") for i in by) == 13
