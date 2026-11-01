"""kb doctor: 경로, 파일시스템, Python, SQLite, 디스크 여유를 JSON으로 낸다."""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys

from kb.core import conn, paths


def run() -> tuple[dict, int]:
    home = paths.kb_home()
    rep: dict = {
        "ok": True,
        "kb_home": str(home),
        "share_dir": str(paths.share_dir()),
        "config_dir": str(paths.config_dir()),
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
    }
    problems = []
    try:
        rep["fs"] = paths.check_fs(home)
    except paths.FsRejected as e:
        rep.update(ok=False, code=paths.FsRejected.code, error=str(e))
        return rep, 1
    if sys.version_info < (3, 14):
        problems.append("python_old")
    if sqlite3.sqlite_version_info < conn.MIN_SQLITE:
        problems.append("sqlite_old")
    p = home
    while not p.exists() and p != p.parent:
        p = p.parent
    free = shutil.disk_usage(p).free
    rep["disk_free_bytes"] = free
    if free < paths.MIN_FREE_BYTES:
        problems.append("disk_low")
    if problems:
        rep.update(ok=False, code=problems[0], problems=problems)
        return rep, 1
    return rep, 0


def _cmd(args) -> int:
    rep, rc = run()
    print(json.dumps(rep, ensure_ascii=False, indent=None if args.json else 2))
    return rc


def register(sub) -> None:
    p = sub.add_parser("doctor", help="환경 점검")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd)
