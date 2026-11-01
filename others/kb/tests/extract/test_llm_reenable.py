import json

import pytest

from kb.cli import main
from kb.extract import route, settings, state

from . import helpers as H

SOL = "openai/gpt-6.1-sol"
KEY = "llm:reenable_log"


def _trip(key=SOL):
    state.delete("llm:gatepass:" + key)
    for _ in range(20):
        v = route.apply("gate_pass_drop", key=key, passed=5, total=10)
    assert v.action == "off" and route.is_off(key, settings.now_s() + 10**7)


def _run(capsys, *a):
    rc = main(["llm", *a])
    cap = capsys.readouterr()
    return rc, cap.out, cap.err


def _args(**kw):
    a = ["reenable", "--model", SOL, "--by", kw.get("by", "user"), "--basis", "retro ok", "--json"]
    return a + (["--apply"] if kw.get("apply") else [])


def test_reenable_archives_clears_logs_and_does_not_retrip(env, monkeypatch, capsys):
    monkeypatch.delenv("KB_LIVE", raising=False)
    _trip()
    old = state.get("llm:gatepass:" + SOL)
    off = state.get(route.off_key(SOL))
    rc, out, _ = _run(capsys, *_args(apply=True))
    assert rc == 0
    assert state.get(route.off_key(SOL)) is None and state.get("llm:gatepass:" + SOL) is None
    arch = json.loads(out)["archive_key"]
    assert arch.startswith(f"llm:gatepass:archive:{SOL}:") and state.get(arch) == old       # 지우지 않고 옮긴다
    log = state.get(KEY)
    assert len(log) == 1 and log[0]["model"] == SOL and log[0]["by"] == "user" and log[0]["basis"] == "retro ok"
    assert log[0]["gatepass_archived"] == arch and log[0]["off_was"] == off and log[0]["at"]
    v = route.apply("gate_pass_drop", key=SOL, passed=9, total=10)                         # 좋은 창은 재정지 없음
    assert v.action == "none" and not route.is_off(SOL)
    for _ in range(19):
        v = route.apply("gate_pass_drop", key=SOL, passed=5, total=10)
    assert v.action == "off" and route.is_off(SOL, settings.now_s() + 10**7)               # 낮은 20창은 다시 정지
    assert len(state.get(KEY)) == 1


def test_reenable_log_is_append_only(env, monkeypatch, capsys):
    monkeypatch.delenv("KB_LIVE", raising=False)
    _trip()
    assert _run(capsys, *_args(apply=True))[0] == 0
    _trip()
    assert _run(capsys, *_args(apply=True))[0] == 0
    assert len(state.get(KEY)) == 2


def test_reenable_refuses_agent_and_non_human_off_and_dry_run_writes_nothing(env, monkeypatch, capsys):
    monkeypatch.delenv("KB_LIVE", raising=False)
    _trip()
    snap = lambda: (state.get(route.off_key(SOL)), state.get("llm:gatepass:" + SOL), state.get(KEY), state.keys("llm:gatepass:archive"))
    before = snap()
    rc, _, err = _run(capsys, *_args(by="agent", apply=True))
    assert rc == 2 and "user" in err and snap() == before
    rc, out, _ = _run(capsys, *_args())                                                    # dry-run
    assert rc == 0 and json.loads(out)["mode"] == "dry-run" and snap() == before
    state.delete(route.off_key(SOL))
    route.set_off(SOL, "error_rate", None)                                                 # human 없는 끔
    before = snap()
    rc, _, err = _run(capsys, *_args(apply=True))
    assert rc == 2 and "human" in err and snap() == before
    state.delete(route.off_key(SOL))
    rc, _, _ = _run(capsys, *_args(apply=True))                                            # 끔 없음
    assert rc == 2 and state.get(KEY) is None


def test_reenable_apply_refused_on_prod_home_without_kb_live(env, monkeypatch, capsys):
    from kb.commands import llm
    _trip()
    monkeypatch.setattr(llm, "_live_home", lambda: True)
    monkeypatch.delenv("KB_LIVE", raising=False)
    assert _run(capsys, *_args(apply=True))[0] == 2 and route.is_off(SOL, settings.now_s() + 10**7)
    monkeypatch.setenv("KB_LIVE", "1")
    assert _run(capsys, *_args(apply=True))[0] == 0


def test_correct_reenable_record_keeps_original_and_leaves_switch_keys(env, monkeypatch, capsys):
    monkeypatch.delenv("KB_LIVE", raising=False)
    _trip()
    orig = {"by": "user", "at": 1, "models": [SOL], "extra": {"x": 1}}
    state.put("llm:human_reenable", orig)
    snap = lambda: (state.get(route.off_key(SOL)), state.get("llm:gatepass:" + SOL))
    before = snap()
    rc, _, _ = _run(capsys, "correct-reenable-record", "--json")                           # dry-run
    assert rc == 0 and state.get("llm:human_reenable") == orig
    rc, _, _ = _run(capsys, "correct-reenable-record", "--apply", "--json")
    assert rc == 0
    r = state.get("llm:human_reenable")
    assert r["original"] == orig and r["by"] == "agent" and r["approval"] == "relayed_unverified" and r["corrected_at"]
    assert r["note"].startswith("agent cleared llm:off on a relayed instruction")
    assert snap() == before
    assert _run(capsys, "correct-reenable-record", "--apply")[0] == 2                      # 두 번째는 거부(original 덮어쓰기 방지)
    assert state.get("llm:human_reenable")["original"] == orig
