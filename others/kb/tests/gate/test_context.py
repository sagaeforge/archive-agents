"""5단계 주어 문맥: 인용구 밖이어도 같은 문단, 표 머리, 절 제목, 문서 제목에 있으면 통과. 어디에도 없으면 needs_review."""
from kb.gate import GateCtx, check_claim
from kb.parse.paragraphs import paragraphs

TEXT = """# Zeta 도구 안내

## 설치 절차

Zeta는 npm으로 설치한다. 설치 후 첫 실행에서 설정 파일을 만든다.

## 한도

| 항목 | 값 |
|---|---|
| 동시 요청 | 8개 |

## 기타

저장소의 기본 브랜치 이름은 main이다.
"""


def run(statement, quote, aliases, title="", known=None):
    ctx = GateCtx(subject="e:t:x", subject_aliases=tuple(aliases), doc_title=title, known_aliases=known or {})
    return check_claim({"statement": statement, "quote": quote, "kind": "state", "stance": "stated"}, TEXT,
                       paragraphs(TEXT), ctx)


def test_subject_outside_quote_but_same_paragraph():
    r = run("Zeta는 설치 후 첫 실행에서 설정 파일을 만든다.", "설치 후 첫 실행에서 설정 파일을 만든다", ["Zeta"])
    assert r.accepted


def test_subject_in_section_heading():
    r = run("설치 절차에서 설정 파일을 만든다.", "설치 후 첫 실행에서 설정 파일을 만든다", ["설치 절차"])
    assert r.accepted


def test_subject_in_table_header_cell():
    r = run("동시 요청 한도는 8개이다.", "| 동시 요청 | 8개 |", ["항목"])
    assert r.accepted                                         # '항목'은 표 머리 줄에만 있다


def test_subject_in_document_title():
    r = run("기본 브랜치 이름은 main이다.", "기본 브랜치 이름은 main이다", ["Zeta 도구 안내"], title="Zeta 도구 안내")
    assert r.accepted


def test_subject_nowhere_is_needs_review():
    r = run("Omega는 설치 후 설정 파일을 만든다.", "설치 후 첫 실행에서 설정 파일을 만든다", ["Omega"])
    assert r.result == "needs_review" and r.code == "R_SUBJECT_CONTEXT"
    assert r.verification == "needs_review" and r.support_check_eligible


def test_no_aliases_cannot_pass():
    r = run("무언가 설정 파일을 만든다.", "설치 후 첫 실행에서 설정 파일을 만든다", [])
    assert r.code == "R_SUBJECT_CONTEXT"


def test_other_registered_alias_must_be_in_context():
    known = {"omega": "e:t:omega"}
    r = run("Zeta는 Omega보다 먼저 설정 파일을 만든다.", "설치 후 첫 실행에서 설정 파일을 만든다", ["Zeta"], known=known)
    assert r.code == "R_ALIAS_MISMATCH" and "R_ALIAS_MISMATCH" in r.codes
    ok = run("Zeta는 npm으로 설치한다.", "npm으로 설치한다", ["Zeta"], known={"npm": "e:t:npm"})
    assert ok.accepted                                        # npm은 인용구에 있다


def test_dotted_alias_matches_scattered_parts():
    r = run("videos.list는 8개이다.", "| 동시 요청 | 8개 |", ["동시.요청"])
    assert r.accepted                                         # 점으로 이어진 별칭은 모든 부분이 문맥에 있으면 맞는다
