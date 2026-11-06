"""수확 원본의 발견과 선별 추출. 읽기 전용이고 네트워크와 프로세스를 쓰지 않는다.

원본 네 가지만 연다. 전사 전체나 도구 출력은 열지 않는다.
- memory: ~/.claude/projects/*/memory/*.md (색인 MEMORY.md 제외)
- workflow: .../<세션>/subagents/workflows/<wf>/journal.jsonl 의 result 줄. 보고 요약만 뽑고 JSON을 통째로 싣지 않는다
- agent_report: .../<세션>/subagents/agent-*.jsonl 의 마지막 assistant 글. 끝난 에이전트의 보고서 길이 글만
- research_doc: 설정한 저장소 체크아웃의 docs/research/*.md
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from kb.harvest.config import Config

KINDS = ("memory", "workflow", "agent_report", "research_doc")
SESSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}")
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")

# 워크플로우 결과에서 싣는 항목. 이 밖의 키(acceptance, changed_paths, reran 등)는 싣지 않는다
RESULT_SCALARS = ("verdict", "status", "recommendation", "evidence", "topic", "report_path")
RESULT_LISTS = ("findings", "facts", "risks", "defects", "unknowns", "open_questions", "needs_user",
                "user_decisions", "incidents")
ITEM_TEXT_KEYS = ("summary", "text", "title", "statement", "description", "issue", "claim", "question")
MAX_LIST_ITEMS = 8
MAX_ITEM_CHARS = 300
MAX_SCALAR_CHARS = 600


@dataclass
class Source:
    kind: str
    key: str                 # 안정된 식별자. 기록 ID의 입력이다
    path: Path
    project: str
    session: str | None
    mtime: float
    size: int
    meta: dict = field(default_factory=dict)


@dataclass
class Extracted:
    title: str
    text: str
    fmt: str                 # markdown | text
    date: str
    session: str | None
    props: dict = field(default_factory=dict)


class SkipSource(Exception):
    """원본을 저장하지 않는 사유. reason은 보고서의 건수 키다."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def project_name(dirname: str) -> str:
    """-home-sagae-sagae-tools -> sagae-tools. 홈 밖이면 앞의 -만 뗀다."""
    m = re.match(r"^-home-[^-]+-(.+)$", dirname)
    return m.group(1) if m else dirname.lstrip("-") or dirname


def iso_date(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _date_of(s) -> str | None:
    m = _DATE_RE.match(s) if isinstance(s, str) else None
    return m.group(1) if m else None


def display_path(p: Path) -> str:
    home = os.path.expanduser("~")
    s = str(p)
    return "~" + s[len(home):] if home != "~" and (s == home or s.startswith(home + os.sep)) else s


def _session_id(s: str | None) -> str | None:
    return s if s and SESSION_RE.fullmatch(s) else None


def _stat(p: Path) -> os.stat_result | None:
    try:
        if p.is_symlink() or not p.is_file():
            return None
        return p.stat()
    except OSError:
        return None


# ------------------------------------------------------------------ 발견

def discover(cfg: Config) -> tuple[list[Source], dict]:
    """(원본 목록, 통계). 목록은 최근 고친 순이다. 스크래치패드 프로젝트는 폴더를 열기 전에 뺀다."""
    out: list[Source] = []
    stats = {"excluded_projects": 0}
    root = cfg.claude_dir()
    rx = cfg.project_regexes()
    if root.is_dir():
        for pdir in sorted(root.iterdir()):
            if not pdir.is_dir() or pdir.is_symlink():
                continue
            if any(r.search(pdir.name) for r in rx):
                stats["excluded_projects"] += 1
                continue
            out.extend(_project_sources(pdir, cfg))
    for repo in cfg.repo_dirs():
        out.extend(_repo_sources(repo, cfg))
    out.sort(key=lambda s: (-s.mtime, s.key))
    stats["found"] = len(out)
    return out, stats


def _project_sources(pdir: Path, cfg: Config) -> list[Source]:
    proj = project_name(pdir.name)
    res: list[Source] = []
    skip_names = set(cfg.exclude_memory_files)
    for f in sorted((pdir / "memory").glob("*.md")):
        st = _stat(f)
        if st is None or f.name in skip_names:
            continue
        res.append(Source("memory", f"memory:{pdir.name}/{f.name}", f, proj, None, st.st_mtime, st.st_size))
    for sess in sorted(p for p in pdir.iterdir() if p.is_dir() and not p.is_symlink()):
        sid = _session_id(sess.name)
        for j in sorted((sess / "subagents" / "workflows").glob("*/journal.jsonl")):
            st = _stat(j)
            if st is None:
                continue
            wf = j.parent.name
            res.append(Source("workflow", f"workflow:{pdir.name}/{sess.name}/{wf}", j, proj, sid, st.st_mtime,
                              st.st_size, {"workflow": wf}))
        for a in sorted((sess / "subagents").glob("agent-*.jsonl")):
            st = _stat(a)
            if st is None:
                continue
            res.append(Source("agent_report", f"agent:{pdir.name}/{sess.name}/{a.stem}", a, proj, sid, st.st_mtime,
                              st.st_size, {"agent_id": a.stem[len("agent-"):], "meta_path": a.with_suffix(".meta.json")}))
    return res


def _repo_sources(repo: Path, cfg: Config) -> list[Source]:
    res: list[Source] = []
    for f in sorted(repo.glob(cfg.research_glob)):
        st = _stat(f)
        if st is None:
            continue
        rel = f.relative_to(repo).as_posix()
        res.append(Source("research_doc", f"doc:{repo.name}/{rel}", f, repo.name, None, st.st_mtime, st.st_size,
                          {"repo": repo.name, "rel": rel}))
    return res


# ------------------------------------------------------------------ 읽기

def _read_text(p: Path, limit: int) -> str:
    try:
        with open(p, "rb") as f:
            raw = f.read(limit + 1)
    except OSError:
        raise SkipSource("unreadable") from None
    if len(raw) > limit:
        raise SkipSource("too_large")
    return raw.decode("utf-8", errors="replace")


def _tail_lines(p: Path, tail_bytes: int) -> list[bytes]:
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            start = max(0, size - tail_bytes)
            f.seek(start)
            data = f.read()
    except OSError:
        raise SkipSource("unreadable") from None
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]          # 첫 줄은 잘렸을 수 있다
    return [ln for ln in lines if ln.strip()]


def check_age(src: Source, cfg: Config, now: float | None = None) -> None:
    n = time.time() if now is None else now
    if n - src.mtime < cfg.min_age_s:
        raise SkipSource("too_new")


def extract(src: Source, cfg: Config) -> Extracted:
    """원본 하나에서 저장할 글을 뽑는다. 저장하지 않을 이유가 있으면 SkipSource."""
    if src.kind == "memory":
        return _memory(src, cfg)
    if src.kind == "workflow":
        return _workflow(src, cfg)
    if src.kind == "agent_report":
        return _agent_report(src, cfg)
    if src.kind == "research_doc":
        return _research_doc(src, cfg)
    raise SkipSource("unknown_kind")


# ------------------------------------------------------------------ memory, research_doc

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """--- 로 싼 머리말의 평면 키와 한 단계 중첩 키(metadata:)만 읽는다. 머리말이 없으면 ({}, text)."""
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    end = next((i for i in range(1, min(len(lines), 60)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text
    meta: dict = {}
    section = None
    for ln in lines[1:end]:
        m = re.match(r"^(\s*)([A-Za-z_][\w-]*):\s*(.*)$", ln)
        if not m:
            continue
        indent, k, v = m.groups()
        v = v.strip().strip("'\"")
        if not indent:
            if v == "":
                section = k
                meta[k] = {}
            else:
                section = None
                meta[k] = v
        elif section and isinstance(meta.get(section), dict):
            meta[section][k] = v
    return meta, "\n".join(lines[end + 1:]).lstrip("\n")


def _first_heading(text: str) -> str | None:
    for ln in text.splitlines():
        m = re.match(r"^#{1,3}\s+(.+?)\s*#*\s*$", ln)
        if m:
            return m.group(1).strip()
    return None


def _memory(src: Source, cfg: Config) -> Extracted:
    text = _read_text(src.path, cfg.max_read_bytes)
    meta, body = parse_frontmatter(text)
    md = meta.get("metadata") if isinstance(meta.get("metadata"), dict) else {}
    mtype = str(md.get("type") or meta.get("type") or "").strip().lower()
    if mtype and mtype in {t.lower() for t in cfg.exclude_memory_types}:
        raise SkipSource("excluded_memory_type")             # type: user(프로필)는 통째로 거두지 않는다. feedback, project, reference는 거둔다
    title = (meta.get("description") or meta.get("name") or _first_heading(body) or src.path.stem)
    props = {}
    if md.get("type"):
        props["memory_type"] = md["type"]
    if meta.get("name"):
        props["memory_name"] = meta["name"]
    return Extracted(title, body, "markdown", _date_of(md.get("modified")) or iso_date(src.mtime),
                     _session_id(md.get("originSessionId")), props)


def _research_doc(src: Source, cfg: Config) -> Extracted:
    text = _read_text(src.path, cfg.max_read_bytes)
    title = _first_heading(text) or src.path.stem
    return Extracted(title, text, "markdown", iso_date(src.mtime), None, {"repo": src.meta.get("repo")})


# ------------------------------------------------------------------ workflow

def _short(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


def _item_text(it) -> str | None:
    if isinstance(it, str):
        return it.strip() or None
    if isinstance(it, dict):
        for k in ITEM_TEXT_KEYS:
            v = it.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def render_result(res) -> str:
    """워크플로우 결과 한 건의 보고 요약. 문자열은 그대로, 객체는 summary와 정해진 짧은 항목만. 없으면 빈 문자열."""
    if isinstance(res, str):
        return res.strip()
    if not isinstance(res, dict):
        return ""
    s = res.get("summary")
    summary = s.strip() if isinstance(s, str) else ""
    bullets: list[str] = []
    for k in RESULT_SCALARS:
        v = res.get(k)
        if isinstance(v, str) and v.strip():
            bullets.append(f"- {k}: {_short(v, MAX_SCALAR_CHARS)}")
    for k in RESULT_LISTS:
        v = res.get(k)
        if not isinstance(v, list):
            continue
        items = [t for t in (_item_text(x) for x in v) if t][:MAX_LIST_ITEMS]
        if items:
            bullets.append(f"- {k}:")
            bullets.extend(f"  - {_short(t, MAX_ITEM_CHARS)}" for t in items)
    if not bullets:
        return summary
    return (summary + "\n\n" if summary else "") + "\n".join(bullets)


def _workflow(src: Source, cfg: Config) -> Extracted:
    text = _read_text(src.path, cfg.max_read_bytes)
    labels: dict = {}
    results: dict = {}
    order: list = []
    for ln in text.splitlines():
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("type") == "started":
            labels[d.get("key")] = d.get("label")
        elif d.get("type") == "result":
            k = d.get("key")
            if k not in results:
                order.append(k)
            results[k] = d.get("result")
    sections, names = [], []
    for k in order:
        body = render_result(results[k])
        if len(body) < cfg.min_result_chars:
            continue
        label = str(labels.get(k) or k)
        names.append(label)
        sections.append(f"## {label}\n\n{body}")
    if not sections:
        raise SkipSource("not_report")
    wf = src.meta.get("workflow", "")
    more = f" 외 {len(names) - 1}건" if len(names) > 1 else ""
    title = f"워크플로우 결과: {names[0]}{more} ({wf})"
    return Extracted(title, "\n\n".join(sections) + "\n", "markdown", iso_date(src.mtime), src.session,
                     {"workflow": wf, "results": len(sections)})


# ------------------------------------------------------------------ agent_report

def _final_report(lines: list[bytes]) -> tuple[str, str | None]:
    """(마지막 assistant 메시지의 글, 시각). end_turn으로 끝나지 않았으면 SkipSource('unfinished')."""
    parsed = []
    for raw in lines:
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("type") == "assistant":
            parsed.append(d)
    if not parsed:
        raise SkipSource("not_report")
    last = parsed[-1]
    msg = last.get("message") if isinstance(last.get("message"), dict) else {}
    if msg.get("stop_reason") != "end_turn":
        raise SkipSource("unfinished")
    mid = msg.get("id")
    texts = []
    for d in parsed:
        m = d.get("message") if isinstance(d.get("message"), dict) else {}
        if m.get("id") != mid:
            continue
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                texts.append(b["text"])
    return "\n\n".join(t.strip() for t in texts if t.strip()), last.get("timestamp")


def _agent_report(src: Source, cfg: Config) -> Extracted:
    meta: dict = {}
    mp = src.meta.get("meta_path")
    if mp is not None and _stat(mp) is not None:
        try:
            m = json.loads(mp.read_text(encoding="utf-8"))
            meta = m if isinstance(m, dict) else {}
        except (OSError, ValueError):
            meta = {}
    if meta.get("finished") is not True:
        raise SkipSource("unfinished")
    atype = meta.get("agentType") if isinstance(meta.get("agentType"), str) else None
    if atype in cfg.exclude_agent_types:
        raise SkipSource("excluded_type")
    text, ts = _final_report(_tail_lines(src.path, cfg.transcript_tail_bytes))
    if not (cfg.min_report_chars <= len(text) <= cfg.max_report_chars):
        raise SkipSource("not_report")
    desc = meta.get("description") if isinstance(meta.get("description"), str) else ""
    first = next((ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip()), "")
    props = {"agent_id": src.meta.get("agent_id")}
    if atype:
        props["agent_type"] = atype
    return Extracted(desc or first or src.path.stem, text, "markdown", _date_of(ts) or iso_date(src.mtime),
                     src.session, props)
