"""inbox/*.md 스캔(계약 6.2). Markdown + YAML 머리말. 작성자는 user:sagae다.

- 30초 이상 수정이 없는 파일만 읽는다. 처리한 파일은 inbox/.done/<날짜>/로 옮긴다.
- 파일을 지워도 레코드가 지워지지 않는다(원장이 원본이다).
- base_version이 어긋나면(또는 기존 id인데 base_version이 없으면) 덮어쓰지 않고 inbox/.conflict/<날짜>/로 옮기고
  dlq(kind=inbox_conflict)에 기록한다.
- 형식 오류 파일은 inbox/.failed/<날짜>/로 옮기고 dlq(kind=inbox_invalid)에 기록한다.
머리말은 pyyaml 없이 읽는 부분집합이다: `키: 값`, 한 줄 흐름 목록 `[a, b]`, 블록 목록 `- a`, 한 단계 들여쓴 `props:`.
"""
from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from kb.core import cas, ledger, opsdb, paths
from kb.write import record
from kb.write.errors import IdemConflict, VersionConflict, WriteRejected

MIN_AGE_S = 30.0
FRONT = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)
HEAD_KEYS = {"id", "base_version", "type", "title", "sensitivity", "links", "body_format", "retention", "props"}


@dataclass
class ScanResult:
    seen: int = 0
    written: int = 0
    held: int = 0
    conflicts: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    skipped_young: int = 0

    def as_dict(self) -> dict:
        return {"seen": self.seen, "written": self.written, "held": self.held, "conflicts": self.conflicts,
                "failed": self.failed, "skipped_young": self.skipped_young}


def _scalar(v: str):
    v = v.strip()
    if " #" in v:
        v = v.split(" #", 1)[0].rstrip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return {"true": True, "false": False, "null": None, "": ""}.get(v, v)


def _flow_list(v: str) -> list:
    inner = v.strip()[1:-1]
    return [_scalar(x) for x in inner.split(",") if x.strip()]


def parse_front(text: str) -> dict:
    out: dict = {}
    cur = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw[0] in " \t" or raw.lstrip().startswith("- "):
            s = raw.strip()
            if s.startswith("- ") and isinstance(out.get(cur), list):
                out[cur].append(_scalar(s[2:]))
            elif cur is not None and isinstance(out.get(cur), dict):
                k, _, v = s.partition(":")
                out[cur][k.strip()] = _flow_list(v) if v.strip().startswith("[") else _scalar(v)
            else:
                raise ValueError(f"머리말 들여쓰기 오류: {raw!r}")
            continue
        k, sep, v = raw.partition(":")
        if not sep:
            raise ValueError(f"머리말 줄 오류: {raw!r}")
        k, v = k.strip(), v.strip()
        cur = k
        if v == "":
            out[k] = [] if k == "links" else ({} if k == "props" else "")
            if k not in ("links", "props"):
                out[k] = ""
        elif v.startswith("["):
            out[k] = _flow_list(v[:v.rfind("]") + 1])
        else:
            out[k] = _scalar(v)
    return out


def parse_file(raw: str, stem: str) -> tuple[dict, dict]:
    """(record 입력, 메타 {id, base_version}). 머리말이 없으면 본문만이다."""
    raw = raw.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    m = FRONT.match(raw)
    if not m and re.match(r"---[ \t]*\n", raw):
        raise WriteRejected("schema_invalid", "머리말이 ---로 시작하지만 닫히지 않았다")
    fm = parse_front(m.group(1)) if m else {}
    body = raw[m.end():] if m else raw
    bad = sorted(set(fm) - HEAD_KEYS)
    if bad:
        raise WriteRejected("schema_invalid", f"머리말 알 수 없는 키: {bad}")
    title = fm.get("title")
    if not title:
        mh = re.search(r"^#\s+(.+)$", body, re.M)
        title = mh.group(1).strip() if mh else stem
    rec: dict = {"title": str(title), "body": body.rstrip("\n") + ("\n" if body.endswith("\n") else "")}
    for k in ("type", "sensitivity", "body_format", "retention", "props"):
        if k in fm and fm[k] not in ("", None):
            rec[k] = fm[k]
    links = fm.get("links") or []
    if links:
        rec["links"] = [{"rtype": "LINKS_TO", "dst": str(x)} for x in links]
    meta = {"id": fm.get("id") or None, "base_version": fm.get("base_version")}
    if meta["base_version"] is not None and not isinstance(meta["base_version"], int):
        raise WriteRejected("schema_invalid", "base_version은 정수")
    return rec, meta


def _day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now))


def _move(src: Path, root: Path, sub: str, now: float, note: str | None = None) -> Path:
    d = root / sub / _day(now)
    cas.make_dirs(d)
    dst = d / src.name
    i = 0
    while dst.exists():
        i += 1
        dst = d / f"{src.stem}.{i}{src.suffix}"
    os.rename(src, dst)
    if note:
        (d / (dst.name + ".txt")).write_text(note, encoding="utf-8")
    cas.fsync_dir(d)
    cas.fsync_dir(src.parent)
    return dst


def _dlq(kind: str, ref: str, error: str, sha: str) -> None:
    c = opsdb.connect()
    try:
        c.execute("INSERT INTO dlq(kind, ref, stage, error, attempts, payload_sha) VALUES(?,?,?,?,1,?)",
                  (kind, ref, "inbox", error[:500], sha))
    finally:
        c.close()


def scan(now: float | None = None, min_age_s: float = MIN_AGE_S) -> ScanResult:
    """inbox/ 바로 아래의 .md 파일을 처리한다. 숨김 폴더(.done 등)는 건너뛴다."""
    root = paths.inbox_dir()
    res = ScanResult()
    if not root.is_dir():
        return res
    t = time.time() if now is None else now
    for p in sorted(root.glob("*.md")):
        if not p.is_file():
            continue
        res.seen += 1
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        if t - st.st_mtime < min_age_s:
            res.skipped_young += 1
            continue
        raw_b = p.read_bytes()
        sha = hashlib.sha256(raw_b).hexdigest()
        try:
            rec, meta = parse_file(raw_b.decode("utf-8"), p.stem)
        except (UnicodeDecodeError, ValueError, WriteRejected) as e:
            _dlq("inbox_invalid", p.name, f"{type(e).__name__}: {e}", sha)
            _move(p, root, ".failed", t, str(e))
            res.failed.append(p.name)
            continue
        if meta["id"]:
            rec["id"] = meta["id"]
            if meta["base_version"] is not None:
                rec["expected_version"] = meta["base_version"]
        key = f"inbox:{meta['id'] or p.stem}:{sha[:32]}"
        try:
            led = ledger.open_ledger()
            try:
                head = ledger.record_head(led, meta["id"]) if meta["id"] else None
            finally:
                led.close()
            if head is not None and meta["base_version"] is None:
                raise VersionConflict(f"base_version 없이 기존 레코드(현재 {head[0]})를 갱신하려 했다")
            r = record.put_record(rec, key, "inbox", key_digest_tail=True)   # 키 끝은 파일 내용 해시
        except (VersionConflict, IdemConflict) as e:
            _dlq("inbox_conflict", p.name, str(e), sha)
            _move(p, root, ".conflict", t, str(e))
            res.conflicts.append(p.name)
            continue
        except WriteRejected as e:
            _dlq("inbox_invalid", p.name, f"{e.code}: {e.message}", sha)
            _move(p, root, ".failed", t, str(e))
            res.failed.append(p.name)
            continue
        res.held += 1 if r.held else 0
        res.written += 0 if r.held else 1
        _move(p, root, ".done", t)
    return res
