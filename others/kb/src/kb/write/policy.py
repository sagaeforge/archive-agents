"""R6 정책 검사. 시스템이 만든 이벤트(origin system, external)의 점수, 기회, 추천 계열 속성을 거부한다.

저장 대상은 출처가 붙은 사실과 관계다(CLAUDE.md 지침 5). 자체 산출 점수와 추천 순위는 저장하지 않는다.
허용: 출처 귀속 순위 주장(chart_rank 등), stance=attributed인 recommends 주장, first_party 이벤트(사용자 또는 세션이 쓴 판단).
"""
from __future__ import annotations

import re
from typing import Any

from kb.write.errors import WriteRejected

_TOKEN = re.compile(r"[a-z0-9]+")
BAD = frozenset({"score", "scores", "scoring", "opportunity", "opportunities", "recommendation", "recommendations",
                 "recommended", "recommend", "recommends"})
ATTRIBUTABLE = frozenset({"recommends"})
SCOPES = ("props", "qualifiers", "attrs")


def _tokens(s: str) -> list[str]:
    return _TOKEN.findall(str(s).lower().replace("-", "_"))


def bad_key(k: str) -> bool:
    return any(t in BAD for t in _tokens(k))


def _walk(obj: Any, in_scope: bool, path: str, out: list[str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if in_scope and bad_key(k):
                out.append(f"{path}/{k}")
            _walk(v, in_scope or k in SCOPES, f"{path}/{k}", out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _walk(v, in_scope, f"{path}/{i}", out)


def lint_event(ev: dict) -> None:
    if ev.get("origin") == "first_party":
        return
    p = ev.get("payload") or {}
    bad: list[str] = []
    _walk(p, False, "", bad)
    pred = p.get("predicate") if ev.get("kind") in ("claim.assert",) else None
    if isinstance(pred, str) and any(t in BAD for t in _tokens(pred)):
        if not (pred in ATTRIBUTABLE and p.get("stance") == "attributed"):
            bad.append(f"predicate={pred}")
    if bad:
        raise WriteRejected("policy_r6", f"점수, 기회, 추천 계열 속성은 저장하지 않는다: {bad[:5]}")


def lint_events(events) -> None:
    for e in events:
        lint_event(e)
