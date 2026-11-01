"""gold 지문: 행 정렬 해시. last_confirmed_at, last_seen_at, meta(applied_seq 등)는 뺀다."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

from kb.core import conn as _conn

ORDER = {
    "node": "vid", "edge": "vid", "claim": "vid", "evidence": "id", "content": "sha", "unit": "rid", "span": "sid",
    "alias": "norm,node_id", "node_domain": "domain,node_id", "series_obs": "oid", "gap": "rowid",
    "change": "seq,sub", "type_def": "name,kind,version", "head": "id", "quarantine": "seq",
}
EXCLUDE = {"evidence": {"last_confirmed_at"}, "series_obs": {"last_seen_at"}}
META_KEYS = ("gold_schema", "epoch")


def _val(v):
    if isinstance(v, (bytes, bytearray)):
        return "b:" + bytes(v).hex()
    return v


def fingerprint_conn(con: sqlite3.Connection) -> str:
    h = hashlib.sha256()
    for t in sorted(ORDER):
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})") if r[1] not in EXCLUDE.get(t, ())]
        h.update(f"#{t}\n".encode())
        cur = con.execute(f"SELECT {','.join(cols)} FROM {t} ORDER BY {ORDER[t]}")
        while True:
            rows = cur.fetchmany(5000)
            if not rows:
                break
            for r in rows:
                h.update(json.dumps([_val(v) for v in r], ensure_ascii=False, separators=(",", ":")).encode())
                h.update(b"\n")
    h.update(b"#fts\n")
    for (rid,) in con.execute("SELECT rowid FROM fts ORDER BY rowid"):
        h.update(f"{rid}\n".encode())
    h.update(b"#meta\n")
    for k in META_KEYS:
        r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        h.update(f"{k}={r[0] if r else ''}\n".encode())
    return h.hexdigest()


def fingerprint(path: str | Path) -> str:
    con = _conn.connect_ro(path, deadline_s=600.0)
    try:
        con.execute("BEGIN")
        return fingerprint_conn(con)
    finally:
        con.close()
