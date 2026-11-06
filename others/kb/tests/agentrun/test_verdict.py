"""기록된 스트림 6종의 판정. exit 0이어도 실패를 잡는다."""
import pytest

from arhelp import FIX
from kb.agentrun import stream, verdict

CASES = {
    "ok": (True, []),
    "permission_denied": (False, ["permission_denials"]),
    "budget_exceeded": (False, ["subtype:error_max_budget_usd"]),
    "wait_ceiling": (False, ["task_stopped"]),
    "mcp_failed": (False, ["mcp_failed:kb-collect"]),
    "is_error": (False, ["is_error", "subtype:error_during_execution"]),
}


def load(name):
    return list(stream.parse_lines(open(FIX / f"stream-{name}.ndjson", encoding="utf-8")))


@pytest.mark.parametrize("name", sorted(CASES))
def test_recorded_stream(name):
    ok, reasons = CASES[name]
    v = verdict.judge(load(name))
    assert v.ok is ok and v.reasons == sorted(reasons)


def test_all_six_fail_except_ok():
    assert [n for n in CASES if verdict.judge(load(n)).ok] == ["ok"]


def test_no_result_and_ingest_condition():
    assert verdict.judge([]).reasons == ["no_result"]
    assert verdict.judge(load("ok"), ingested=0, require_ingest=True).reasons == ["no_ingest"]
    assert verdict.judge(load("ok"), ingested=3, require_ingest=True).ok


def test_last_result_wins():
    evs = load("is_error") + load("ok")
    assert [e for e in evs if e["type"] == "result"][-1]["is_error"] is False
    assert verdict.judge(evs).ok  # 앞선 result(배경 작업 중간 결과)는 무시하고 마지막만 본다
