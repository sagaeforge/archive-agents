"""kb schema sync: schemas/types, schemas/predicates.yaml, schemas/predicates.d를 원장에 등록한다."""
from __future__ import annotations

import hashlib

from kb.core import ledger, opsdb, paths
from kb.write import engine as _commit
from kb.write import types


def sync_schema() -> dict:
    """내용이 같으면 쓰지 않는다. 쓴 이벤트 수와 전체 수를 돌려준다."""
    led = ledger.open_ledger()
    try:
        evs, stats = types.sync_events(led)
    finally:
        led.close()
    stats["events"] = len(evs)
    if evs:
        r = _commit.commit(evs, types.SYNC_ACTOR)
        stats["projected"] = r.projected
    return stats


def files_fingerprint() -> str:
    """tick이 변경을 알아채는 용도의 지문. 이름과 내용을 묶는다."""
    root = paths.share_dir() / "schemas"
    h = hashlib.sha256()
    for sub in ("types", "predicates.d"):
        d = root / sub
        if d.is_dir():
            for p in sorted(d.glob("*")):
                h.update(p.name.encode() + b"\0" + p.read_bytes() + b"\0")
    f = root / "predicates.yaml"
    if f.is_file():
        h.update(f.read_bytes())
    return h.hexdigest()


def sync_if_changed() -> dict | None:
    fp = files_fingerprint()
    c = opsdb.connect()
    try:
        if opsdb.tick_state_get(c, "schema_files_sha") == fp:
            return None
    finally:
        c.close()
    stats = sync_schema()
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, "schema_files_sha", fp)
    finally:
        c.close()
    return stats
