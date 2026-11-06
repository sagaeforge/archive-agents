"""전사 ETL: ~/.claude/projects 아래 *.jsonl(30일 뒤 사라진다)을 읽어 수치만 ops.db metric에 적재한다.
읽기 전용이고 원문을 복제하지 않는다. 비공식 스키마라 파싱 실패(깨진 줄, usage 누락/비정수)를 transcript.parse_fail로 센다.
파일별 읽은 위치를 tick_state에 두어 다시 돌려도 중복 적재하지 않는다. 같은 requestId의 usage는 한 번만 센다.
적재: transcript.tokens{kind=input|output|cache_read|cache_create, model}, transcript.lines, transcript.files,
transcript.parse_fail, transcript.trail_calls, transcript.kb_calls."""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

RETAIN_DAYS = 30
KINDS = (("input_tokens", "input"), ("output_tokens", "output"),
         ("cache_read_input_tokens", "cache_read"), ("cache_creation_input_tokens", "cache_create"))


def default_root() -> Path:
    return Path(os.environ.get("KB_TRANSCRIPT_ROOT") or Path.home() / ".claude" / "projects")


def _fkey(p: Path) -> str:
    return "transcript:" + hashlib.sha1(str(p).encode()).hexdigest()[:16]


def parse_file(path: Path, offset: int = 0) -> tuple[dict, int]:
    """한 파일의 offset 이후를 읽어 합계를 낸다. (합계, 새 offset). 마지막 줄이 개행 없이 끝나면 다음에 다시 읽는다."""
    agg = {"lines": 0, "parse_fail": 0, "trail": 0, "kb": 0, "tokens": {}}
    seen: set[str] = set()
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1
    for raw in data[:end].splitlines():
        if not raw.strip():
            continue
        agg["lines"] += 1
        try:
            o = json.loads(raw)
            if not isinstance(o, dict):
                raise ValueError
        except ValueError:
            agg["parse_fail"] += 1
            continue
        if o.get("type") != "assistant":
            continue
        msg = o.get("message")
        if not isinstance(msg, dict):
            agg["parse_fail"] += 1
            continue
        for c in msg.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_use":
                n = str(c.get("name") or "")
                if n.startswith("mcp__trail__"):
                    agg["trail"] += 1
                elif n.startswith("mcp__kb__") or "tower__kb_" in n:
                    agg["kb"] += 1
        u = msg.get("usage")
        rid = str(o.get("requestId") or msg.get("id") or "")
        if rid and rid in seen:
            continue
        if not isinstance(u, dict) or not all(isinstance(u.get(k), int) and not isinstance(u.get(k), bool)
                                              for k in ("input_tokens", "output_tokens")):
            agg["parse_fail"] += 1
            continue
        if rid:
            seen.add(rid)
        model = str(msg.get("model") or "unknown")[:40]
        for k, kind in KINDS:
            v = u.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                key = (kind, model)
                agg["tokens"][key] = agg["tokens"].get(key, 0) + v
    return agg, offset + end


def etl(conn, root: Path | None = None, now_ms: int | None = None, *, retain_days: int = RETAIN_DAYS) -> dict:
    from kb.core import opsdb
    root = Path(root) if root else default_root()
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    out = {"files": 0, "lines": 0, "parse_fail": 0, "tokens": 0}
    if not root.is_dir():
        return out
    cutoff = now / 1000 - retain_days * 86400
    for p in sorted(root.rglob("*.jsonl")):
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        key = _fkey(p)
        off = int(opsdb.tick_state_get(conn, key, "0") or 0)
        if off > st.st_size:  # 잘렸거나 교체된 파일은 처음부터
            off = 0
        if off == st.st_size:
            continue
        try:
            agg, new_off = parse_file(p, off)
        except OSError:
            continue
        out["files"] += 1
        out["lines"] += agg["lines"]
        out["parse_fail"] += agg["parse_fail"]
        for (kind, model), v in agg["tokens"].items():
            opsdb.record_metric(conn, "transcript.tokens", v, {"kind": kind, "model": model}, at=now)
            out["tokens"] += v
        for name, v in (("transcript.lines", agg["lines"]), ("transcript.parse_fail", agg["parse_fail"]),
                        ("transcript.trail_calls", agg["trail"]), ("transcript.kb_calls", agg["kb"]), ("transcript.files", 1)):
            if v:
                opsdb.record_metric(conn, name, v, None, at=now)
        opsdb.tick_state_set(conn, key, new_off)
    return out


def job_transcript_etl(ctx=None) -> dict:
    """tick 내부 작업(주 1회). 전역 파일은 읽기만 한다."""
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        return etl(c)
    finally:
        c.close()
