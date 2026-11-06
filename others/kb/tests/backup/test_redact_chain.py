"""kb redact: 라이브 조회, 재구축, 봉인 세그먼트, git, spool, inbox, ops/runs, restic 과거 세대, 체인."""
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest
from compression import zstd

from bkhelp import file_has, held_item, open_fp, project, put, tree_has
from kb import read
from kb.core import cas, conn, ledger, spool
from kb.core.canon import canon_json
from kb.guard import export_md, ship
from kb.guard import redact as R
from kb.write import WriteRejected, owner
from wrhelp import gold_row

N1 = "NEEDLE-N1-REDACT-7781"


def _cfg(bk, local_commit=True):
    h = bk.home
    bk.write_config([{"id": "local-c", "kind": "local", "repo": str(h / "repos" / "local-c")}])
    bk.init()
    (bk.cfg / "config.toml").write_text(f"[export]\nlocal_commit = {'true' if local_commit else 'false'}\n")


def _ev(rid, body, key):
    return {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": rid, "idem_key": key,
            "payload": {"id": rid, "type": "Note", "title": "t", "body": body, "sensitivity": "internal"}}


def test_full_chain(bk):
    h = bk.home
    _cfg(bk)
    open_fp()
    big = N1 + " " + "나라 " * 30000          # 64KB 초과: raw/fp
    r1 = put("지울 것", big, key="r1", props={"memo": N1 + " 메모"}).id
    ro = put("남길 것", "다른 레코드 본문입니다").id
    assert list(cas.iter_shas("fp")), "raw/fp 객체가 있다"
    # spool: R1만 든 항목, R1과 다른 레코드가 섞인 항목
    spool.put("in", {"events": [_ev(r1, N1 + " 대기", "sp-a")]}, "a1")
    spool.put("in", {"events": [_ev(r1, N1 + " 혼합", "sp-b"), _ev(ro, "다른 대기 본문", "sp-c")]}, "b1")
    # inbox/.done, 평문 임시 파일, 묵은 임시 파일, 어린 임시 파일
    done = h / "inbox" / ".done" / "2026-11-01"
    done.mkdir(parents=True)
    (done / "r1.md").write_text(f"---\nid: {r1}\ntype: Note\ntitle: t\n---\n\n{N1} 파일\n")
    (done / "other.md").write_text("---\nid: f-other\ntype: Note\ntitle: o\n---\n\n무관\n")
    tmp_plain = cas.write_temp(h / "spool" / "in", canon_json(_ev(r1, big, "sp-t")))
    (h / "raw" / "objects").mkdir(parents=True, exist_ok=True)
    tmp_old = cas.write_temp(h / "raw" / "objects", b"old leftover")
    os.utime(tmp_old, (time.time() - 7200,) * 2)
    (h / "spool" / "l2").mkdir(parents=True, exist_ok=True)
    tmp_young = cas.write_temp(h / "spool" / "l2", b"young leftover")
    # ops/runs 스트림
    runs = h / "ops" / "runs"
    runs.mkdir(parents=True)
    rows = [json.dumps({"msg": f"put {r1}"}), json.dumps({"msg": "무관한 행"}), json.dumps({"x": N1 + " 메모"})]
    (runs / "run-1.jsonl.zst").write_bytes(zstd.compress(("\n".join(rows) + "\n").encode()))
    project()
    # 봉인, 전송, 평문 내보내기(+로컬 커밋): 평문이 사방에 있다
    assert ship.ship()["ok"]
    ex = export_md.export_markdown()
    assert ex["committed"] and tree_has(export_md.export_root() / "records", N1.encode())
    repo = h / "repos" / "local-c"
    assert tree_has(h / "ledger", N1.encode()) and tree_has(h / "ship", N1.encode())

    res = R.redact_record(r1, "시험 삭제", rebuild_gold=True)
    assert res["ok"] and res["wal_cleared"]

    # 1) 라이브 조회 불가, 재구축 뒤 파생에 없음
    with read.reading(read.ReadCtx()) as con:
        with pytest.raises((read.NotFound, read.ContentRemoved)):
            read.node_body(con, read.ReadCtx(), r1)
    assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (r1,))[0][0] == "[redacted]"
    assert tree_has(h / "derived", N1.encode()) == []
    assert owner.read_record(ro, tty=True)["body"] == "다른 레코드 본문입니다"
    # 2) 원장 파일과 WAL, 봉인 세그먼트 재봉인, MANIFEST
    assert tree_has(h / "ledger", N1.encode()) == []
    assert any(r["kind"] == "resealed" for r in ledger.manifest_rows())
    led = conn.connect_ro(ledger.ledger_path())
    assert ledger.verify_chain(led).ok
    assert led.execute("SELECT version FROM record_head WHERE id=?", (r1,)).fetchone()[0] == 2
    led.close()
    # 3) raw/fp, spool, inbox, ops/runs, 임시 파일, 원장 사본
    assert not list(cas.iter_shas("fp")) and res["cas"]["deleted"]
    assert not (h / "spool" / "in" / "a1.json").exists()
    kept = json.loads((h / "spool" / "in" / "b1.json").read_text())["events"]
    assert [e["subject"] for e in kept] == [ro], "다른 레코드의 대기 쓰기는 남는다"
    assert not (done / "r1.md").exists() and (done / "other.md").exists()
    assert not tmp_plain.exists() and not tmp_old.exists() and tmp_young.exists()
    data = zstd.decompress((runs / "run-1.jsonl.zst").read_bytes()).decode()
    assert r1 not in data and N1 not in data and json.dumps("무관한 행")[1:-1] in data
    assert not (h / "ship" / "ledger.db").exists()
    assert tree_has(h / "spool", N1.encode()) == [] and tree_has(h / "inbox", N1.encode()) == []
    # 4) git 이력: 재작성 전에는 남아 있고, 재작성 뒤에는 없다
    root = export_md.export_root()
    from kb.guard.redact import _git
    export_md.export_markdown()   # 작업 트리에서 파일이 빠지고 커밋된다
    assert N1 in _git(root, "log", "-p", "--all").stdout, "이력에는 남아 있다"
    g = R.purge_git(root, [export_md.rel_path(r1)])
    assert g["rewritten"]
    assert N1 not in _git(root, "log", "-p", "--all").stdout
    assert _git(root, "rev-list", "--all", "--count").stdout.strip() != "0"
    # 5) restic 과거 세대: rewrite + prune 뒤 모든 스냅샷에서 사라진다
    out = R.purge_restic(rid=r1)
    assert out["targets"][0]["pruned"] and out["targets"][0]["rewritten"] >= 1, out
    t, sec = ship.load_targets()[0], ship.load_secrets()
    snaps = json.loads(ship.run_restic(t, ["snapshots", "--json"], sec).stdout)
    assert snaps
    for i, s in enumerate(snaps):
        dst = h / f"verify-{i}"
        ship.run_restic(t, ["restore", s["id"], "--target", str(dst)], sec)
        assert tree_has(dst, N1.encode()) == [], (s["tags"], tree_has(dst, N1.encode()))
    # 6) 체인이 유지된 복원 사본이 있다
    t0 = [s for s in snaps if "t0" in s["tags"]][-1]
    d0 = h / "verify-t0"
    ship.run_restic(t, ["restore", t0["id"], "--target", str(d0)], sec)
    copy = next(d0.rglob("ship/ledger.db"))
    c = conn.connect_ro(copy)
    try:
        assert ledger.verify_chain(c).ok
    finally:
        c.close()


def test_shared_cas_object_is_kept_and_reported(bk):
    _cfg(bk, local_commit=False)
    open_fp()
    body = "SHARED-BODY-1 " + "공유 " * 30000
    a = put("가", body, key="sa").id
    b = put("나", body, key="sb").id
    shas = list(cas.iter_shas("fp"))
    assert len(shas) == 1
    r = R.redact_record(a, "공유 시험")
    assert r["ok"] and not r["cas"]["deleted"]
    assert r["cas"]["kept"] == [{"sha": shas[0], "tier": "fp", "shared_with": [b]}]
    assert r["shared_report"]["cas"] and cas.exists(shas[0], "fp")
    r2 = R.redact_record(b, "공유 시험 2")
    assert r2["cas"]["deleted"] and not cas.exists(shas[0], "fp"), "마지막 사용자가 지워지면 객체도 간다"


def test_body_in_many_segments_is_resealed_everywhere(bk):
    open_fp()
    X = {"id": "f-m1", "type": "Note", "title": "t", "body": "MULTI-NEEDLE-X", "sensitivity": "internal"}
    Y = {**X, "body": "MULTI-NEEDLE-Y"}
    A, B, C = 1_790_000_000_000, 1_800_000_000_000, 1_810_000_000_000   # 서로 다른 달
    def ev(sub, pl, at, key):
        return {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": sub,
                "idem_key": key, "payload": pl, "at": at}
    led = ledger.open_ledger()
    ledger.append(led, [ev("f-m1", X, A, "m1"), ev("f-x", {"id": "f-x", "type": "Note", "title": "o", "body": "남음",
                                                               "sensitivity": "internal"}, B, "m2"),
                        ev("f-m1", Y, B, "m3"), ev("f-m1", X, C, "m4")])
    made = ledger.export_segment(led)
    led.close()
    assert len(made) == 3
    r = R.redact_record("f-m1", "여러 세그먼트")
    assert r["ok"] and len(r["resealed"]) == 3
    assert tree_has(ledger.export_dir(), b"MULTI-NEEDLE") == []
    led = ledger.open_ledger()
    try:
        assert ledger.verify_chain(led).ok
        assert ledger.reseal_segment(led, 1) is None, "더 바꿀 것이 없다"
    finally:
        led.close()


def test_wal_not_cleared_is_reported_and_second_call_finishes(bk):
    open_fp()
    rid = put("지울 것", "WAL-NEEDLE-5521 본문").id
    c = ledger.open_ledger()
    c.execute("PRAGMA wal_autocheckpoint=0")
    c.close()
    ro = conn.connect_ro(ledger.ledger_path())
    ro.execute("BEGIN")
    ro.execute("SELECT count(*) FROM payload").fetchone()
    r = R.redact_record(rid, "읽기 연결이 막는다")
    assert r["ok"] is False and r["wal_cleared"] is False
    assert tree_has(ledger.ledger_path().parent, b"WAL-NEEDLE-5521"), "체크포인트가 막혀 평문이 아직 파일에 있다"
    ro.execute("ROLLBACK")
    ro.close()
    r2 = R.redact_record(rid, "읽기 연결이 막는다")
    assert r2["ok"] and r2["wal_cleared"]
    assert tree_has(ledger.ledger_path().parent, b"WAL-NEEDLE-5521") == []


def test_sweep_tmp_leaves_young_files_and_removes_stale_ones(bk):
    h = bk.home
    d1 = h / "spool" / "in"
    d2 = h / "raw" / "objects"
    spool.put("in", {"events": []}, "x")
    d2.mkdir(parents=True, exist_ok=True)
    young = cas.write_temp(d1, b"young")
    old = cas.write_temp(d2, b"old")
    os.utime(old, (time.time() - 5000,) * 2)
    gone = R.sweep_tmp(min_age_s=3600)
    assert str(old) in gone and young.exists() and not old.exists()
    assert str(young) in R.sweep_tmp(min_age_s=0)


def test_redact_needs_reason_and_existing_record(bk):
    open_fp()
    with pytest.raises(R.RedactError):
        R.redact_record("f-none", "사유")
    rid = put("a", "b").id
    with pytest.raises(R.RedactError):
        R.redact_record(rid, " ")


def test_cli_needs_tty(bk, monkeypatch, capsys):
    from kb.cli import main
    open_fp()
    rid = put("a", "b").id
    monkeypatch.setattr("kb.write.tty.is_tty", lambda: False)
    assert main(["redact", rid, "--reason", "x", "--json"]) == 1
    assert "TTY" in capsys.readouterr().out
    monkeypatch.setattr("kb.write.tty.is_tty", lambda: True)
    assert main(["redact", rid, "--reason", "x", "--no-rebuild", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_read_record_after_redact_raises_content_removed(bk):
    _cfg(bk)
    open_fp()
    rid = put("지울 것", "삭제될 본문", key="rr1").id
    assert owner.read_record(rid, tty=True)["body"] == "삭제될 본문"
    assert R.redact_record(rid, "시험 삭제")["ok"]
    with pytest.raises(WriteRejected) as e:
        owner.read_record(rid, tty=True)
    assert e.value.code == "content_removed"
