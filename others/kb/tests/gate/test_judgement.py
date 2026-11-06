"""7단계 판단어(R6): 영어·명령형 탐지, 화자 확정 시 attributed + speaker, 미확정 E_JUDGEMENT, howto 기본 attributed,
판단어 문장은 support_check 큐에 들어가지 않는다."""
import pytest

from kb.gate import GateCtx, check_claim, support
from kb.gate.judgement import judgement_words
from kb.parse.paragraphs import paragraphs

from .conftest import queue_rows

TEXT = """# Guide

You should use the --bare flag for scripts. Use it in CI. We recommend pinning versions. It uses 3 retries.

문서는 캐시를 쓴다. 캐시 크기는 5개다.
"""
P = paragraphs(TEXT)


def run(statement, quote, **kw):
    ctx = GateCtx(subject="e:t:x", subject_aliases=("--bare", "guide"), publisher=kw.pop("publisher", "Anthropic Docs"))
    return check_claim({"statement": statement, "quote": quote, "kind": kw.pop("kind", "state"),
                        "stance": kw.pop("stance", "stated"), "speaker": kw.pop("speaker", None)}, TEXT, P, ctx)


@pytest.mark.parametrize("st", [
    "스크립트에는 --bare 플래그를 사용해야 한다.", "스크립트에는 --bare 플래그를 쓰기를 권장한다.", "버전 고정을 추천한다.",
    "Scripts should use the --bare flag.", "CI must pin versions.", "Docs recommend pinning versions.",
    "This is the best practice for CI.", "CI에서 --bare 플래그를 사용하세요.", "Use the --bare flag in CI.",
    "Do not use --bare in interactive mode."])
def test_vocabulary_detected(st):
    assert judgement_words(st), st


@pytest.mark.parametrize("st", ["--bare 플래그는 스크립트용이다.", "캐시 크기는 5개다.", "It uses 3 retries.", "2단계 인증이 켜져 있어야 한다."])
def test_plain_facts_not_flagged(st):
    assert not judgement_words(st), st


def test_judgement_becomes_attributed_with_publisher_as_speaker():
    r = run("스크립트에는 --bare 플래그를 사용해야 한다.", "You should use the --bare flag for scripts")
    assert r.accepted and r.judgement
    assert r.stance == "attributed" and r.speaker == "Anthropic Docs" and r.verification == "quote_found"


def test_explicit_speaker_is_kept():
    r = run("버전 고정을 추천한다.", "We recommend pinning versions", stance="attributed", speaker="문서 저자")
    assert r.accepted and r.speaker == "문서 저자" and r.stance == "attributed"


def test_unknown_speaker_is_rejected():
    r = run("Scripts should use the --bare flag.", "You should use the --bare flag for scripts", publisher=None)
    assert r.rejected and r.code == "E_JUDGEMENT"


def test_howto_defaults_to_attributed():
    r = run("CI에서 사용한다.", "Use it in CI", kind="howto")
    assert r.accepted and r.stance == "attributed" and r.speaker == "Anthropic Docs" and not r.judgement
    r2 = run("CI에서 사용한다.", "Use it in CI", kind="howto", publisher=None)
    assert r2.rejected and r2.code == "E_JUDGEMENT"


def test_attributed_without_speaker_uses_publisher():
    r = run("캐시 크기는 5개다.", "캐시 크기는 5개다", stance="attributed")
    assert r.accepted and r.speaker == "Anthropic Docs"


def test_judgement_sentence_never_enters_support_check_queue(env):
    # 값 불일치(3 -> 9)가 있는 판단어 문장과 없는 일반 문장을 둘 다 needs_review로 만든다
    j = run("CI에서는 재시도를 9번 사용해야 한다.", "It uses 3 retries")
    p = run("캐시 크기는 9개다.", "캐시 크기는 5개다")
    assert j.result == "needs_review" and j.judgement and not j.support_check_eligible
    assert p.result == "needs_review" and not p.judgement and p.support_check_eligible
    assert support.enqueue("c-judge", j) is False
    assert support.enqueue("c-plain", p) is True
    assert queue_rows("support_check") == ["c-plain"]


def test_sensitive_scope_is_not_queued(env):
    p = run("캐시 크기는 9개다.", "캐시 크기는 5개다")
    assert support.enqueue("c-sens", p, scope="sensitive") is False
    assert queue_rows("support_check") == []
