"""gold DB 열기와 스키마. 쓰기 연결은 kb.core.conn.connect_rw(synchronous=NORMAL)만 쓴다."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from kb.core import conn as _conn
from kb.core import paths

GOLD_SCHEMA = 3
SCHEMA_SQL = Path(__file__).with_name("schema.sql")


class SchemaMismatch(RuntimeError):
    """gold_schema가 이 코드의 값과 다르다. 프로세스는 투영을 거부한다(ADR 22장)."""


def gold_root() -> Path:
    return paths.kb_home() / "derived" / "gold"


def gate_path() -> Path:
    return paths.ledger_dir() / "write.gate"


def meta_get(g: sqlite3.Connection, k: str) -> str | None:
    r = g.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else None


def meta_set(g: sqlite3.Connection, k: str, v) -> None:
    g.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def create_gold(path: str | Path) -> sqlite3.Connection:
    """새 gold 파일을 만들고 스키마를 넣는다. 이미 있는 파일은 거부한다."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        raise FileExistsError(str(p))
    g = _conn.connect_rw(p, "NORMAL")
    g.execute("BEGIN IMMEDIATE")
    try:
        for stmt in _statements(SCHEMA_SQL.read_text(encoding="utf-8")):
            g.execute(stmt)
        g.executemany("INSERT INTO meta(k,v) VALUES(?,?)",
                      [("gold_schema", str(GOLD_SCHEMA)), ("applied_seq", "0"), ("epoch", "0")])
        g.execute("COMMIT")
    except BaseException:
        if g.in_transaction:
            g.execute("ROLLBACK")
        g.close()
        raise
    return g


def _statements(sql: str):
    # 한 줄 주석을 지우고 세미콜론으로 나눈다. 트리거 본문의 세미콜론은 문장이 끝날 때까지 이어 붙인다.
    lines = [ln.split("--", 1)[0] for ln in sql.splitlines()]
    buf = ""
    for part in "\n".join(lines).split(";"):
        buf += part + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip(" \n;"):
                yield buf.strip()
            buf = ""


def open_gold(path: str | Path) -> sqlite3.Connection:
    """기존 gold를 쓰기로 연다. gold_schema가 다르면 SchemaMismatch."""
    g = _conn.connect_rw(path, "NORMAL")
    check_schema(g)
    return g


def check_schema(g: sqlite3.Connection) -> None:
    try:
        v = meta_get(g, "gold_schema")
    except sqlite3.DatabaseError as e:
        raise SchemaMismatch(f"gold 스키마를 읽지 못함: {e}") from e
    if v != str(GOLD_SCHEMA):
        raise SchemaMismatch(f"gold_schema={v!r}, 이 코드={GOLD_SCHEMA}")
