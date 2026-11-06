"""SQLite 연결. 쓰기 연결은 저장소 전체에서 connect_rw만 쓴다."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from kb.core import paths

MIN_SQLITE = (3, 51, 3)


class SqliteTooOld(RuntimeError):
    pass


def connect_rw(path: str | Path, sync: str = "FULL") -> sqlite3.Connection:
    if sqlite3.sqlite_version_info < MIN_SQLITE:
        raise SqliteTooOld(
            f"SQLite {sqlite3.sqlite_version} < {'.'.join(map(str, MIN_SQLITE))}: 쓰기 거부"
        )
    sync = str(sync).upper()
    if sync not in {"OFF", "NORMAL", "FULL", "EXTRA", "0", "1", "2", "3"}:
        raise ValueError(f"sync 값 오류: {sync}")
    paths.check_fs(Path(path).parent)
    con = sqlite3.connect(str(path), isolation_level=None, timeout=5.0)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(f"PRAGMA synchronous={sync}")
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def connect_ro(path: str | Path, deadline_s: float = 5.0) -> sqlite3.Connection:
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=deadline_s)
    con.execute("PRAGMA query_only=ON")
    end = time.monotonic() + deadline_s
    # 반환값이 0이 아니면 SQLite가 질의를 중단한다.
    con.set_progress_handler(lambda: 1 if time.monotonic() > end else 0, 10000)
    return con
