"""gold WAL 절단, 커밋 뒤 투영 전 SIGKILL, gold_schema 불일치, 첫 rebuild."""
import os
import shutil
import subprocess
import sys
import textwrap

import pytest

from kb.core import ledger
from kb.project import (SchemaMismatch, create_gold, current_build, current_gold_path, fingerprint_conn, open_gold,
                        project_tail, rebuild, replay)
from kb.project.db import meta_set
from projhelp import E, golden_events, new_gold


def _full_fp(led, kb_home, name):
    g = new_gold(kb_home, name)
    replay(led, g, missing="skip")
    fp = fingerprint_conn(g)
    g.close()
    return fp


def test_wal_truncation_replays_from_applied_seq(led, kb_home):
    ledger.append(led, golden_events())
    g = new_gold(kb_home, "w")
    for _ in range(6):  # 작은 트랜잭션 여러 개: WAL에 프레임이 쌓인다
        project_tail(led, g, 8, 10 ** 6, missing="skip")
    wal = str(kb_home / "scratch" / "w.db") + "-wal"
    assert os.path.getsize(wal) > 0
    # 열린 연결에서 db와 WAL을 복사한 뒤 WAL을 중간에서 자른다
    dst = kb_home / "scratch" / "cut"
    dst.mkdir()
    shutil.copy(kb_home / "scratch" / "w.db", dst / "g.db")
    with open(wal, "rb") as f:
        data = f.read()
    (dst / "g.db-wal").write_bytes(data[: len(data) // 2])
    g.close()
    g2 = open_gold(dst / "g.db")
    applied = int(g2.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0])
    assert applied < 52, "WAL 절단으로 뒤쪽 이벤트가 사라졌어야 한다"
    while not project_tail(led, g2, 20, 10 ** 6, missing="skip").caught_up:
        pass
    assert fingerprint_conn(g2) == _full_fp(led, kb_home, "full")
    g2.close()


def test_sigkill_after_ledger_commit_before_projection(led, kb_home):
    script = textwrap.dedent("""
        import os, signal, sys
        sys.path.insert(0, %r)
        from kb.core import ledger
        from projhelp import golden_events
        c = ledger.open_ledger()
        ledger.append(c, golden_events())
        os.kill(os.getpid(), signal.SIGKILL)   # 원장 커밋 뒤, 투영 전
    """) % os.path.dirname(__file__)
    p = subprocess.run([sys.executable, "-c", script], env=os.environ.copy())
    assert p.returncode == -9
    g = new_gold(kb_home, "k")
    r = project_tail(led, g, None, 10 ** 6, missing="skip")
    assert r.caught_up and r.last_seq == 52
    assert fingerprint_conn(g) == _full_fp(led, kb_home, "kfull")
    g.close()


def test_gold_schema_mismatch_refuses(led, kb_home):
    ledger.append(led, [E("source.registered", {"id": "src:a"}, "src:a")])
    g = new_gold(kb_home, "m")
    g.execute("BEGIN IMMEDIATE")
    meta_set(g, "gold_schema", 999)
    g.execute("COMMIT")
    with pytest.raises(SchemaMismatch):
        project_tail(led, g)
    assert g.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0] == "0"
    g.close()
    with pytest.raises(SchemaMismatch):
        open_gold(kb_home / "scratch" / "m.db")


def test_first_rebuild_on_empty_ledger(led, kb_home):
    assert current_gold_path() is None
    r = rebuild(led=led)
    assert r.swapped and r.last_seq == 0 and not r.fingerprint_compared and r.fingerprint_ok
    assert current_build() == r.build and current_gold_path().exists()
    # CAS 객체가 필요한 이벤트는 뺀다(옛 빌드는 격리하고 새 빌드는 건너뛰므로 견줄 수 없다)
    ledger.append(led, [e for e in golden_events() if e["kind"] not in ("snapshot.text", "series.batch")])
    r2 = rebuild(led=led)
    assert (r2.fingerprint_compared or r2.forced) and r2.fingerprint_ok and r2.old_build == r.build  # 골든에 redact/release가 있으면 forced
    assert r2.build_id.startswith("g-000000050-")
