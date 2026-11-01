"""public, internal first_party 레코드를 결정적 Markdown으로 export/first_party(별도 git) 작업 트리에 쓴다.

- private, secret, 지운 레코드, 묘비는 내보내지 않는다. 이미 있던 파일이면 지운다.
- 로컬 커밋은 config export.local_commit=true일 때만이다(기본 false, 결정 13). 푸시는 export.push_allowed=true일 때만이다(기본 false).
- 같은 원장이면 같은 바이트다(키 정렬, 시각 없음).
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from urllib.parse import quote

from kb.core import cas, config, ledger, paths
from kb.core import conn as _conn
from kb.guard import anchor
from kb.guard.redact import _git

EXPORTABLE = ("public", "internal")
MAX_NAME = 200


def export_root() -> Path:
    return paths.kb_home() / "export" / "first_party"


def rel_path(record_id: str) -> str:
    name = quote(record_id, safe="")
    if len(name) > MAX_NAME:
        from kb.core.canon import sha256_hex
        name = name[:80] + "~" + sha256_hex(record_id.encode())[:32]
    return f"records/{name}.md"


def render(pl: dict, version: int, body: str) -> str:
    head = {"id": pl["id"], "version": version, "type": pl.get("type"), "title": pl.get("title"),
            "sensitivity": pl.get("sensitivity"), "body_format": pl.get("body_format") or "markdown"}
    for k in ("retention", "props", "links", "authored_at"):
        if pl.get(k) not in (None, {}, []):
            head[k] = pl[k]
    lines = ["---"]
    for k in sorted(head):
        lines.append(f"{k}: {json.dumps(head[k], ensure_ascii=False, sort_keys=True)}")
    lines.append("---")
    return "\n".join(lines) + "\n\n" + body.rstrip("\n") + "\n"


def _records(c) -> dict[str, tuple[int, dict]]:
    out = {}
    for rid, ver, sha in c.execute("SELECT id, version, content_sha FROM record_head ORDER BY id"):
        last = c.execute("SELECT kind, origin FROM event WHERE subject=? ORDER BY seq DESC LIMIT 1", (rid,)).fetchone()
        if not last or last[0] != "record.put" or last[1] != "first_party":
            continue
        pl = ledger.get_payload(c, sha)
        if not pl or pl.get("sensitivity") not in EXPORTABLE or (pl.get("props") or {}).get("quarantine"):
            continue
        out[rid] = (ver, pl)
    return out


def export_markdown(*, commit: bool | None = None) -> dict:
    """작업 트리를 원장과 맞춘다. commit이 None이면 config export.local_commit을 따른다."""
    root = export_root()
    cas.make_dirs(root / "records")
    p = ledger.ledger_path()
    recs: dict = {}
    if p.exists():
        c = _conn.connect_ro(p, 60.0)
        try:
            recs = _records(c)
            lead = ledger.head(c)
        finally:
            c.close()
    else:
        lead = (0, ledger.GENESIS)
    want: dict[str, str] = {}
    for rid, (ver, pl) in recs.items():
        body = pl.get("body")
        if body is None and pl.get("body_sha"):
            body = cas.get(pl["body_sha"], "fp").decode()
        want[rel_path(rid)] = render(pl, ver, body or "")
    wrote = removed = 0
    for rel, text in sorted(want.items()):
        f = root / rel
        data = text.encode()
        if not f.exists() or f.read_bytes() != data:
            cas.atomic_write(f, data)
            wrote += 1
    for f in sorted((root / "records").glob("*.md")):
        if f"records/{f.name}" not in want:
            f.unlink()
            removed += 1
    out = {"root": str(root), "records": len(want), "wrote": wrote, "removed": removed, "committed": False,
           "pushed": False, "head_seq": lead[0]}
    do_commit = config.get("export.local_commit") if commit is None else commit
    if do_commit:
        out["committed"] = _commit(root, lead)
        if config.get("export.push_allowed"):
            out["pushed"] = _push(root)
    return out


def _commit(root: Path, lead: tuple[int, str]) -> bool:
    if not (root / ".git").exists():
        _git(root, "init", "-q")
    _git(root, "add", "-A")
    if _git(root, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    a = anchor.latest()
    msg = f"export first_party seq={lead[0]}"
    if a:
        msg += f"\n\nanchor: seq={a['seq']} head_hash={a['head_hash']} at={a['at']}"
    _git(root, "commit", "-q", "-m", msg)
    return True


def _push(root: Path) -> bool:
    r = _git(root, "push", check=False)
    return r.returncode == 0
