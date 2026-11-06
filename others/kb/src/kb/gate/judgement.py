"""7단계 판단어(R6) 린트와 8단계 주입 패턴. 저장소는 판단을 만들지 않는다(CLAUDE.md 지침 5):
판단어 문장은 소스 발행처의 말로 귀속(attributed + speaker)하거나, 화자를 못 정하면 거부한다."""
from __future__ import annotations

import re
import unicodedata

_JUDGE = [re.compile(p, re.I) for p in (
    r"해야\s*(?:한다|합니다|함|하며|하고|하다|된다|돼요|해요)", r"하여야", r"하셔야", r"추천", r"권장", r"권고", r"바람직",
    r"\bshould(?:n't|\s+not)?\b", r"\bshouldn't\b", r"\bmust(?:n't|\s+not)?\b", r"\bought\s+to\b",
    r"\brecommend(?:s|ed|ation|ations|ing)?\b", r"\bbest[\s-]+practices?\b", r"하는\s*(?:것이|게)\s*좋")]
_IMP_KO = re.compile(r"(?:하세요|하십시오|하십시요|마세요|마십시오|하라|해라|하자|바랍니다|바란다|해 주세요|해주세요)$")
_IMP_EN = re.compile(r"^(?:please\s+)?(?:do\s+not|don't|never|always|use|set|add|run|avoid|prefer|make\s+sure|consider|enable|"
                     r"disable|install|check|ensure|try|keep|remove|create|open|configure|write|read|call|pass|put|"
                     r"choose|select|update|upgrade|replace|wrap)\b", re.I)
_SENT = re.compile(r"(?<=[.!?。！？])\s+|\n+")


def judgement_words(statement: str) -> list:
    """판단어와 명령형 문장. 비면 판단 문장이 아니다."""
    hits = [p.pattern for p in _JUDGE if p.search(statement)]
    for s in _SENT.split(statement.strip()):
        t = s.strip().rstrip(".!?。！？\"'”’)")
        if t and (_IMP_KO.search(t) or _IMP_EN.match(t)):
            hits.append("imperative")
            break
    return hits


_INJ = [re.compile(p, re.I) for p in (
    r"ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?)",
    r"disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)?\s*(?:instructions?|prompts?|rules?)",
    r"forget\s+(?:all\s+|everything\s+)?(?:previous|prior|above|your)\s+(?:instructions?|rules?|context)",
    r"you\s+are\s+now\s+(?:a|an|in)\b", r"new\s+instructions?\s*:", r"system\s+prompt", r"override\s+(?:the\s+)?(?:system|safety)",
    r"(?:이전|위의|앞의|기존)\s*(?:지시|지침|명령|프롬프트)(?:를|을|사항을)?\s*(?:모두\s*)?(?:무시|잊)",
    r"지시(?:를|을)\s*무시", r"시스템\s*프롬프트", r"<\s*/?\s*(?:system|assistant|instructions?)\s*>", r"\[/?INST\]",
    r"(?m)^\s*(?:system|assistant)\s*:", r"<\|(?:im_start|im_end|system)\|>",
    # 파이프라인 설정 변경 요구(범위, 민감도, 백엔드). "set the model to"는 G 도메인의 정상 사용법이라 넣지 않는다
    r"(?:set|change|switch|mark|treat)\s+(?:the\s+|this\s+)?(?:document\s+|doc\s+)?(?:sensitivity|scope|backend)\b",
    r"\b(?:sensitivity|scope|backend)\b[^.\n]{0,40}\b(?:to|as)\s+(?:public|internal|private|secret|sensitive|codex|openrouter|claude)\b",
    r"(?:민감도|범위|백엔드|라우팅)\s*(?:를|을)?\s*[^.\n]{0,30}(?:바꾸|바꿔|변경|설정|지정|처리)\s*(?:하라|해라|하세요|하십시오|해\b|라\b)",
    r"(?:민감도|범위|백엔드)\s*[^.\n]{0,20}(?:으로|로)\s*(?:바꾸|바꿔|변경|처리)",
    # 도구 호출 요구. "call the function"은 개발 문서의 정상 문장이라 도구와 셸만 본다
    r"(?:call|invoke|execute)\s+(?:the\s+)?(?:tool|shell|bash)\b",
    r"(?:도구|툴|셸)\s*(?:를|을)?\s*[^.\n]{0,20}(?:호출|실행)\s*(?:하라|해라|하세요|하십시오|해\b)")]
_BAD_CF = set("​‌‍‎‏‪‫‬‭‮⁠⁡⁢⁣⁤⁦⁧⁨⁩﻿")


def injection(*texts: str) -> str | None:
    """주입 패턴이나 제어 문자가 있으면 이유(원문 일부를 싣지 않는다), 없으면 None."""
    for t in texts:
        if not t:
            continue
        for ch in t:
            if ch in _BAD_CF or (unicodedata.category(ch) == "Cc" and ch not in "\t\n\r"):
                return f"제어·서식 문자 U+{ord(ch):04X}"
        for p in _INJ:
            if p.search(t):
                return "주입 패턴"
    return None
