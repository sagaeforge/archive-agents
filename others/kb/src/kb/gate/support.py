"""needs_review 주장을 함의 판정 경로(ADR-0003 2장, WP-19)로 보내는 큐. 대상은 공개 범위의
R_VALUE_MISMATCH, R_SUBJECT_CONTEXT, R_ALIAS_MISMATCH뿐이다. 판단어 문장은 오지 않는다(RULE-17):
함의 판정은 인용구가 문장을 뒷받침하는지만 보므로 귀속 없는 판단을 올릴 수 있다."""
from __future__ import annotations

from kb.core import opsdb
from kb.gate.model import GateResult

QUEUE_KIND = "support_check"


def eligible(res: GateResult, scope: str = "public") -> bool:
    return scope == "public" and res.support_check_eligible


def enqueue(claim_id: str, res: GateResult, scope: str = "public") -> bool:
    """대상이면 queue(kind=support_check)에 넣고 True. 이미 있거나 대상이 아니면 False."""
    if not eligible(res, scope):
        return False
    return opsdb.queue_put(QUEUE_KIND, claim_id, priority=0)
