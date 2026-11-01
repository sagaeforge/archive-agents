"""골든 원장 재생: 지문 고정, 파서와 LLM 호출 0회, 배치와 문단 예산에 불변, build_id 결정성."""
import sys
from pathlib import Path

import pytest

from kb.core import ledger
from kb.project import apply as ap
from kb.project import build_id_of, fingerprint_conn, project_tail, replay
from projhelp import golden_events, new_gold

FP = Path(__file__).with_name("golden.fingerprint")


def load(led):
    ledger.append(led, golden_events())


def test_golden_fingerprint(led, kb_home, monkeypatch):
    load(led)
    # 파서, LLM, 네트워크 모듈이 불리면 실패한다
    import socket
    import subprocess

    def boom(*a, **k):
        raise AssertionError("재구축 중 외부 호출")
    monkeypatch.setattr(socket, "create_connection", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    # 재구축 코드가 파서·추출기·수집기 패키지를 끌어오지 않는다
    assert not [m for m in sys.modules if m.split(".")[:2] in (["kb", "parse"], ["kb", "extract"], ["kb", "collect"])]
    g = new_gold(kb_home, "a")
    replay(led, g, missing="skip")
    fp = fingerprint_conn(g)
    assert fp == FP.read_text().strip(), f"골든 지문이 바뀌었다: {fp}"


@pytest.mark.parametrize("batch,budget", [(1, 1), (3, 5), (7, 200), (1000, 10 ** 6)])
def test_batch_and_budget_do_not_change_fingerprint(led, kb_home, batch, budget):
    load(led)
    g = new_gold(kb_home, f"b{batch}")
    replay(led, g, batch=batch, para_budget=budget, missing="skip")
    assert fingerprint_conn(g) == FP.read_text().strip()


def test_same_input_same_build_id(led, kb_home):
    load(led)
    a = build_id_of(led)
    assert a.startswith("g-000000052-") and len(a) == len("g-000000052-xxxx")
    assert build_id_of(led) == a


def test_apply_reads_no_clock(led, kb_home, monkeypatch):
    import time
    load(led)
    g = new_gold(kb_home, "c")
    monkeypatch.setattr(time, "time", lambda: (_ for _ in ()).throw(AssertionError("시계를 읽음")))
    monkeypatch.setattr(time, "time_ns", lambda: (_ for _ in ()).throw(AssertionError("시계를 읽음")))
    r = project_tail(led, g, None, 10 ** 9, missing="skip")
    assert r.caught_up and r.last_seq == 52 and not r.quarantined
