"""WP-02 인계: 결합 토큰 2_1_314가 unicode61에서 `2 1 314`로 쪼개져도 버전 문자열이 구문 질의로 찾힌다."""
import sqlite3

import pytest

from kb.core.text import index_tokens, query_tokens
from kb.read.search import build_plan, lexical_ids

from .shelp import ids, record


def _fts(docs):
    c = sqlite3.connect(":memory:")
    c.execute("CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 0\")")
    for i, t in enumerate(docs, 1):
        c.execute("INSERT INTO fts(rowid,tok) VALUES(?,?)", (i, " ".join(index_tokens(t))))
    return c


def test_unicode61_splits_joined_token_but_phrase_still_matches():
    assert "2_1_314" in index_tokens("Claude Code 2.1.314")
    c = _fts(["Claude Code 2.1.314에서 추가", "버전 2.1.315 공개", "314 1 2 순서 뒤집힘", "2 와 1 그리고 314 가 따로"])
    # 결합 토큰 한 개가 세 토큰으로 쪼개진다
    assert [r[0] for r in c.execute("SELECT 1 FROM fts WHERE fts MATCH '\"2_1_314\"'")] == [1]
    # 따옴표 없는 식은 FTS5 구문 오류가 아니라 AND 연산이 되어 순서 뒤집힌 문서도 맞는다(그래서 항상 따옴표로 보낸다)
    assert len(c.execute("SELECT 1 FROM fts WHERE fts MATCH '2 1 314'").fetchall()) >= 3


@pytest.mark.parametrize("q", ["2.1.314", "2_1_314", "claude code 2.1.314"])
def test_version_query_and_stage_finds_only_the_exact_version(q):
    c = _fts(["Claude Code 2.1.314에서 추가", "버전 2.1.315 공개", "314 1 2 순서 뒤집힘", "2 와 1 그리고 314 가 따로"])
    plan = build_plan(q)
    got = lexical_ids(c, plan, k=1)  # k=1: AND 결과가 있으면 OR로 내려가지 않는다
    assert got == [1]


def test_version_phrase_through_search(w):
    w.add(record("f-v1", "Claude Code 2.1.314 변경 내역"), record("f-v2", "Claude Code 2.1.315 변경 내역"),
          record("f-v3", "314 와 1 그리고 2 의 순서가 다른 메모"))
    from kb.read import search as S
    r = S.search("2.1.314", w.ctx(), kinds="record")
    assert ids(r)[0] == "f-v1"
    # AND 단계는 정확히 한 건이고, 나머지는 OR 이음이다
    plan = build_plan("2.1.314")
    assert plan.and_expr().startswith('"2_1_314"')
    assert query_tokens("2.1.314") == ["2_1_314", "2", "1", "314"]


def test_second_version_in_same_doc_keeps_phrase_positions():
    # 부분 토큰이 겹치는 두 버전이 한 문서에 있어도 뒤쪽 버전의 구문이 끊기지 않는다
    assert index_tokens("2.1.314 2.1.315") == ["2_1_314", "2", "1", "314", "2_1_315", "2", "1", "315"]
    c = _fts(["2.1.314 다음은 2.1.315", "2.1.316 단독"])
    assert lexical_ids(c, build_plan("2.1.315"), k=1) == [1]


def test_repeated_term_raises_bm25_rank():
    # 문서 안 반복이 TF로 남아야 Ko-StrategyQA ndcg가 나온다. 색인에서 중복을 지우면 뒤집힌다
    assert index_tokens("훅 훅").count("훅") == 2
    assert query_tokens("훅 훅") == ["훅"]
    c = _fts(["훅 설정 안내 문서 내용 하나", "훅 훅 훅 설정 안내 문서 내용"])
    assert [r[0] for r in c.execute("SELECT rowid FROM fts WHERE fts MATCH '\"훅\"' ORDER BY rank")] == [2, 1]
