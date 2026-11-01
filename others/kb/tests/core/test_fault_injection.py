"""검사기 고장 주입. 해로운 플립 = 논리 내용이 바뀌었는데 체인 + 재생 대조 + integrity_check가 모두 통과한 경우."""
import random
import shutil
import sqlite3
from pathlib import Path

import pytest

from kb.core import ledger
from kb.core.ids import record_id

N = 300


def _build(kb_home):
    c = ledger.open_ledger()
    n = 0
    for i in range(25):
        rid = f"f-{i % 6}"
        ledger.append(c, [
            {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": rid,
             "idem_key": f"a{i}", "payload": {"i": i, "txt": "본문" * (i + 1)}},
            {"kind": "claim.assert", "actor": "agent:x", "on_behalf_of": "user:sagae", "generated_by": "m1",
             "origin": "external", "subject": f"c-{i}", "idem_key": f"b{i}", "payload": {"id": f"c-{i}"}}])
    ledger.append(c, [{"kind": "schema.epoch_bumped", "actor": "system", "origin": "system", "idem_key": "ep",
                       "payload": {"reason": "t"}},
                      {"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system", "idem_key": "fp",
                       "payload": {"mode": "drill"}}])
    ledger.redact(c, "f-3", "시험", "user:sagae")
    return c


def _dump(c):
    return {t: c.execute(f"SELECT * FROM {t} ORDER BY 1,2").fetchall()
            for t in ("event", "payload", "record_head", "meta")}


def _flip(v, rng):
    if v is None:
        return "x"
    if isinstance(v, bool):
        return not v
    if isinstance(v, int):
        return v ^ (1 << rng.randrange(0, 20))
    if isinstance(v, str):
        i = rng.randrange(len(v))
        ch = v[i]
        # ASCII 문자는 낮은 비트, 그 밖은 코드포인트 낮은 비트를 뒤집는다
        return v[:i] + chr(ord(ch) ^ (1 << rng.randrange(0, 5))) + v[i + 1:]
    if isinstance(v, bytes):
        i = rng.randrange(len(v))
        return v[:i] + bytes([v[i] ^ (1 << rng.randrange(8))]) + v[i + 1:]
    raise TypeError(type(v))


def test_bit_flips_never_pass_all_checks(kb_home):
    base = _build(kb_home)
    assert ledger.verify_chain(base).ok and ledger.integrity(base) == []
    base.close()
    src = ledger.ledger_path()
    rng = random.Random(2026)
    cols = {"event": ledger.EVENT_COLS, "payload": ("sha", "body"), "record_head": ("id", "version", "content_sha"),
            "meta": ("k", "v")}
    undetected, detected_by = [], {"chain": 0, "integrity": 0}
    for n in range(N):
        work = kb_home / f"flip{n}.db"
        shutil.copyfile(src, work)
        c = sqlite3.connect(work, isolation_level=None)
        c.execute("PRAGMA journal_mode=DELETE")
        before = _dump(c)
        table = rng.choice(list(cols))
        col = rng.choice(cols[table])
        keycol = {"event": "seq", "payload": "sha", "record_head": "id", "meta": "k"}[table]
        rows = c.execute(f"SELECT {keycol}, {col} FROM {table}").fetchall()
        key, val = rng.choice(rows)
        # 트리거를 잠시 걷고 플립한 뒤 같은 DDL로 되돌린다(검사기는 트리거 존재도 대조한다)
        for name in ledger.TRIGGERS:
            c.execute(f"DROP TRIGGER {name}")
        new = None if (val is not None and col in ("on_behalf_of", "generated_by", "subject") and rng.random() < .3) \
            else _flip(val, rng)
        try:
            c.execute(f"UPDATE {table} SET {col}=? WHERE {keycol}=?", (new, key))
        except sqlite3.IntegrityError:
            c.close()
            continue  # 유일성 위반으로 플립 자체가 불가
        for ddl in ledger.TRIGGERS.values():
            c.execute(ddl)
        after = _dump(c)
        if after == before:
            c.close()
            continue
        problems = ledger.verify_chain(c).errors
        integ = ledger.integrity(c)
        if problems:
            detected_by["chain"] += 1
        elif integ:
            detected_by["integrity"] += 1
        else:
            undetected.append((table, col, key, val, new))
        c.close()
        work.unlink()
    print("detected", detected_by, "undetected", len(undetected))
    assert undetected == []
    assert detected_by["chain"] >= N * 0.9


def test_raw_file_byte_flips(kb_home):
    base = _build(kb_home)
    base.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    before = _dump(base)
    base.close()
    data = ledger.ledger_path().read_bytes()
    rng = random.Random(5)
    harmful = 0
    for n in range(150):
        k = rng.randrange(len(data))
        bad = data[:k] + bytes([data[k] ^ (1 << rng.randrange(8))]) + data[k + 1:]
        work = kb_home / f"raw{n}.db"
        work.write_bytes(bad)
        try:
            c = sqlite3.connect(work, isolation_level=None)
            c.text_factory = lambda b: b.decode("utf-8", "surrogateescape")
            c.execute("PRAGMA journal_mode=DELETE")
            same = _dump(c) == before
            if same:
                c.close()
                continue
            ok = not ledger.verify_chain(c).errors and ledger.integrity(c) == []
            c.close()
        except (sqlite3.DatabaseError, UnicodeError):
            ok = False  # 열리지 않거나 읽다 깨짐 = 탐지
        harmful += ok
        work.unlink()
    assert harmful == 0
