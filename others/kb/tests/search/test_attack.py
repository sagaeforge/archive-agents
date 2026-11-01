"""표기 공격 26건(tests/fixtures/tokens/attack.json): 전부 적중, 빈 결과 0. 4음절 어절 사례는 현재 동작을 표본으로 고정한다."""
import pytest

from kb.read import search as S

from .shelp import fixture, ids, record

TOP = 5


@pytest.fixture
def attack_world(w):
    d = fixture("attack.json")
    w.add([record(f"f-{c['id']}", c["text"], body="") for c in d["corpus"]])
    return w, d


def test_all_26_cases_hit(attack_world):
    w, d = attack_world
    assert len(d["cases"]) == 26
    miss, empty = [], []
    for c in d["cases"]:
        got = ids(S.search(c["query"], w.ctx(), kinds="record", limit=TOP))
        if not got:
            empty.append(c["query"])
        if f"f-{c['expect']}" not in got:
            miss.append((c["query"], got))
    assert empty == []
    assert miss == []


def test_four_syllable_eojeol_current_behaviour(w):
    """4음절 이상 어절 속의 1음절 단어는 어절 전체를 입력해야 찾힌다(계약 4.8). 현재 동작을 표본으로 고정한다."""
    e = fixture("attack_edge.json")
    w.add([record(f"f-e{i}", s, body="") for i, s in enumerate(e["edge_sentences"])])
    sent = {f"f-e{i}": s for i, s in enumerate(e["edge_sentences"])}

    def top(q):
        return [sent[i] for i in ids(S.search(q, w.ctx(), kinds="record"))]

    # 3음절 이하 어절(훅을, 훅으로, 훅에서)은 첫 음절 색인으로 `훅`이 찾는다. 4음절 어절(훅에서는, 훅이라는)은 못 찾는다
    assert top("훅") == ["훅을 쓴다", "훅으로 막는다", "훅에서 실행된다"]
    # 4음절 어절 속의 앱, 탭, 봇은 한 음절만으로 찾지 못한다
    assert top("앱") == [] and top("탭") == [] and top("봇") == []
    # 어절 전체를 입력하면 그 문장이 맨 앞이다
    assert top("훅에서는")[0] == "훅에서는 실행된다"
    assert top("앱으로는")[0] == "앱으로는 안 된다"
    assert top("탭에서만")[0] == "탭에서만 보인다"
    assert top("봇이라도")[0] == "봇이라도 쓴다"
