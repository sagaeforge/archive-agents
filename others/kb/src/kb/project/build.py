"""재구축과 교체(ADR 2, 7.2). 라이브 DB 파일을 옮기거나 바꾸지 않는다. 빌드 디렉터리를 새로 만들고
게이트를 쥔 채 `current` symlink만 바꾼다."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from kb.core import cas, ledger, opsdb
from kb.core import conn as _conn
from kb.core.gatelock import Gate
from kb.core.ids import uuid7
from kb.project import apply as ap
from kb.project.db import (GOLD_SCHEMA, SchemaMismatch, create_gold, gate_path, gold_root, meta_get, meta_set,
                           open_gold)
from kb.project.fingerprint import fingerprint_conn
from kb.project.tail import project_tail

KEEP_OLD = 2
BIG = 10 ** 12
LED_DEADLINE_S = 600.0


class RebuildError(RuntimeError):
    pass


@dataclass
class BuildResult:
    build: str = ""
    path: str = ""
    build_id: str = ""
    last_seq: int = 0
    swapped: bool = False
    rolled_back: bool = False
    fingerprint: str | None = None
    fingerprint_ok: bool = True
    fingerprint_compared: bool = False
    forced: bool = False
    old_build: str | None = None
    missing: list = field(default_factory=list)
    gate_held_ms: float = 0.0
    quarantined: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def current_link() -> Path:
    return gold_root() / "current"


def current_build() -> str | None:
    try:
        return os.readlink(current_link())
    except OSError:
        return None


def current_gold_path() -> Path | None:
    p = current_link() / "graph.db"
    return p if p.exists() else None


def _point_current(build: str) -> None:
    """게이트를 쥔 채 호출한다. .next symlink를 만들고 current로 rename한 뒤 디렉터리를 fsync한다."""
    root = gold_root()
    current_next = root / "current.next"
    if current_next.is_symlink() or current_next.exists():
        current_next.unlink()
    os.symlink(build, current_next)
    os.replace(current_next, current_link())
    cas.fsync_dir(root)


def build_id_of(led: sqlite3.Connection) -> str:
    seq, h = ledger.head(led)
    d = hashlib.sha256(f"{GOLD_SCHEMA}|{seq}|{h}".encode()).hexdigest()[:4]
    return f"g-{seq:09d}-{d}"


def replay(led: sqlite3.Connection, g: sqlite3.Connection, *, batch: int = 2000, para_budget: int = 10000,
           missing: str = "fatal", until: int | None = None, write_quarantine: bool = True) -> tuple[int, list, list]:
    """caught_up이 될 때까지 project_tail을 되풀이한다. (last_seq, 없는 객체, 격리된 seq)."""
    miss: set[str] = set()
    quar: list[int] = []
    while True:
        r = project_tail(led, g, batch, para_budget, missing=missing, until=until, write_quarantine=write_quarantine)
        miss.update(r.missing)
        quar += r.quarantined
        if r.env_error:
            raise RebuildError(f"환경 실패로 재생 중단: {r.env_error}")
        if r.caught_up:
            return r.last_seq, sorted(miss), quar


def _catch_up(led: sqlite3.Connection, g: sqlite3.Connection, missing: str) -> list:
    _, miss, _ = replay(led, g, batch=BIG, para_budget=BIG, missing=missing)
    return miss


def _read_txn(path: Path) -> tuple[sqlite3.Connection, int]:
    ro = _conn.connect_ro(path, deadline_s=600.0)
    ro.execute("BEGIN")
    return ro, int(meta_get(ro, "applied_seq") or 0)


def _prune(root: Path) -> None:
    keep = current_build()
    dirs = sorted((d for d in root.iterdir() if d.is_dir() and not d.is_symlink() and not d.name.startswith(".")),
                  key=lambda d: d.name, reverse=True)
    old = 0
    for d in dirs:
        if d.name == keep:
            continue
        old += 1
        if old > KEEP_OLD or (d / "BAD").exists():
            shutil.rmtree(d, ignore_errors=True)


def rebuild(allow_missing: bool = False, *, batch: int = 2000, para_budget: int = 10000,
            gate_timeout: float = 60.0, led: sqlite3.Connection | None = None) -> BuildResult:
    own = led is None
    if led is None:
        led = ledger.open_ledger()
    root = gold_root()
    root.mkdir(parents=True, exist_ok=True)
    mode = "skip" if allow_missing else "fatal"
    res = BuildResult(build="b" + uuid7().replace("-", ""))
    bdir = root / res.build
    res.path = str(bdir / "graph.db")
    g = None
    swapped = False
    try:
        g = create_gold(bdir / "graph.db")
        # 1) 게이트 없이 재생. 쓰기는 멈추지 않는다.
        last, miss, quar = replay(led, g, batch=batch, para_budget=para_budget, missing=mode)
        # 2) 게이트: 꼬리 따라잡기 -> 체크포인트 -> 같은 applied_seq의 읽기 트랜잭션 -> 교체
        gate = Gate(gate_path())
        fd = gate.acquire(gate_timeout)
        t0 = time.monotonic()
        old_ro = new_ro = None
        forced = False  # 증분이 할 수 없는 변경(release, redact)이 있어 지문 비교를 건너뛴다
        try:
            res.old_build = current_build()
            old_path = current_gold_path()
            if old_path is not None:
                try:
                    og = open_gold(old_path)
                except SchemaMismatch:
                    og = None
                    old_path = None
                if og is not None:
                    try:
                        # FW5 이전 DB는 같은 schema 3이어도 큰 본문/파생 민감도/묘비
                        # 투영이 다르다. 새 빌드를 채택하며 옛 지문과 같다고 주장하지 않는다.
                        legacy_fp = meta_get(og, "fp_projection") != "5"
                        _catch_up(led, og, "quarantine")
                        forced = legacy_fp or meta_get(og, "rebuild_required_seq") is not None
                    finally:
                        og.close()
            miss += _catch_up(led, g, mode)
            g.execute("BEGIN IMMEDIATE")  # 새 빌드는 전부 재생한 결과라 표시를 채택하며 지운다
            g.execute("DELETE FROM meta WHERE k='rebuild_required_seq'")
            g.execute("COMMIT")
            res.build_id = build_id_of(led)
            g.execute("BEGIN IMMEDIATE")
            meta_set(g, "build_id", res.build_id)
            g.execute("COMMIT")
            g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            new_ro, new_seq = _read_txn(bdir / "graph.db")
            if old_path is not None:
                old_ro, old_seq = _read_txn(old_path)
                if old_seq != new_seq:
                    raise RebuildError(f"applied_seq 불일치: 옛 {old_seq}, 새 {new_seq}")
            res.last_seq = new_seq
            _point_current(res.build)
            swapped = True
            res.swapped = True
        finally:
            gate.release(fd)
            res.gate_held_ms = (time.monotonic() - t0) * 1000
        res.missing = sorted(set(miss))
        res.quarantined = quar
        # 3) 게이트 밖에서 두 스냅샷의 지문 비교
        res.fingerprint = fingerprint_conn(new_ro)
        if old_ro is not None and forced:
            res.forced = True  # 지문 비교 생략. 무결성(applied_seq)은 위에서 검사했다
        elif old_ro is not None:
            res.fingerprint_compared = True
            old_fp = fingerprint_conn(old_ro)
            res.fingerprint_ok = old_fp == res.fingerprint
        new_ro.close()
        if old_ro is not None:
            old_ro.close()
        new_ro = old_ro = None
        if not res.fingerprint_ok:
            _alarm(f"gold 지문 불일치: 새 {res.build} 를 되돌림")
            _roll_back(led, res, gate_timeout)
        else:
            _prune(root)
        return res
    except BaseException:
        if not swapped:
            if g is not None:
                try:
                    g.close()
                except sqlite3.Error:
                    pass
                g = None
            shutil.rmtree(bdir, ignore_errors=True)
        raise
    finally:
        if g is not None:
            try:
                g.close()
            except sqlite3.Error:
                pass
        if own:
            led.close()


def _roll_back(led: sqlite3.Connection, res: BuildResult, gate_timeout: float) -> None:
    gate = Gate(gate_path())
    fd = gate.acquire(gate_timeout)
    try:
        old = res.old_build
        if old and (gold_root() / old / "graph.db").exists():
            _point_current(old)
            og = open_gold(gold_root() / old / "graph.db")
            try:
                _catch_up(led, og, "quarantine")
            finally:
                og.close()
            res.rolled_back = True
        (gold_root() / res.build / "BAD").write_text("fingerprint mismatch\n")
    finally:
        gate.release(fd)


def _alarm(detail: str) -> None:
    try:
        opsdb.record_incident(opsdb.connect(), "projection_fingerprint", detail)
    except Exception:  # noqa: BLE001 - 경보 실패가 되돌림을 막으면 안 된다
        pass


def verify_projection(led: sqlite3.Connection | None = None) -> dict:
    """current를 게이트 없이 한 스냅샷으로 읽고, 같은 applied_seq까지 새로 재생한 지문과 비교한다."""
    cur = current_gold_path()
    if cur is None:
        return {"ok": False, "error": "current 없음"}
    own = led is None
    ro_led = _conn.connect_ro(ledger.ledger_path(), deadline_s=LED_DEADLINE_S) if own else led
    ro, seq = _read_txn(cur)
    tmp = gold_root() / (".verify-" + uuid7().replace("-", ""))
    try:
        if meta_get(ro, "fp_projection") != "5":
            return {"ok": True, "rebuild_pending": True, "reason": "fp_projection_upgrade", "applied_seq": seq}
        pending = meta_get(ro, "rebuild_required_seq")
        if pending is not None:  # 증분이 할 수 없는 변경이 남아 있다. 실패가 아니라 재구축 대기다.
            return {"ok": True, "rebuild_pending": True, "rebuild_required_seq": int(pending), "applied_seq": seq}
        fp_cur = fingerprint_conn(ro)
        g = create_gold(tmp / "graph.db")
        try:
            replay(ro_led, g, until=seq, missing="skip", write_quarantine=False)
            g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            fp_new = fingerprint_conn(g)
        finally:
            g.close()
        return {"ok": fp_cur == fp_new, "applied_seq": seq, "current": fp_cur, "replayed": fp_new}
    finally:
        ro.close()
        shutil.rmtree(tmp, ignore_errors=True)
        if own:
            ro_led.close()
