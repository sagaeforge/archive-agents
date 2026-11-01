"""토큰 추정과 카드 예산: 1.5×한글 + 0.5×기타, 문장 중간 절단 없음, 카드 첫 칸이 id, 제어 문자 제거, 점수 필드 없음."""
import json

from kb import read
from kb.read.budget import clean, est_tokens, take
from .rhelp import claim, entity, snap


def test_estimate_formula():
    assert est_tokens("") == 0
    assert est_tokens("가나다") == 5  # 4.5 올림
    assert est_tokens("abc") == 2  # 1.5 올림
    assert est_tokens("가a") == 2  # 1.5 + 0.5
    assert est_tokens("a" * 40) == 20 != len("a" * 40) // 4  # chars/4가 아니다
    assert est_tokens("한" * 10) == 15
    assert take([3, 3, 3], 7) == 2 and take([5, 1], 4) == 0


def test_clean_removes_tabs_newlines_controls():
    assert clean("a\tb\nc\r\nd\x00e\x1b[0m  f") == "a b c d e [0m f"
    assert "\t" not in clean("x\ty") and clean(None) == ""


def _world(w, n=12):
    w.add(entity("e:tool:x", "X"), snap(), *[claim(f"c-{i:02d}", "e:tool:x", f"x는 {i}번째 기능으로 위젯을 지원한다. 설정에서 켠다.") for i in range(n)],
          claim("c-ctl", "e:tool:x", "x는\t탭과\n개행이 있는\r문장이다"))


def test_cards_never_cut_mid_sentence_and_first_cell_is_id(w):
    _world(w)
    ids = [f"c-{i:02d}" for i in range(12)]
    with w.rd() as (con, c):
        full = read.render_cards(con, c, ids, budget=100_000)
        small = read.render_cards(con, c, ids, budget=150)
    assert full.n == 12 and full.more == 0 and full.cur is None
    assert 0 < small.n < 12 and small.more == 12 - small.n and small.cur
    assert small.tokens <= 150 and small.text.split("\n")[0].count("cur=") == 1
    sent = {ln.split("\t")[0]: ln.split("\t")[1] for ln in full.text.split("\n")[1:]}
    for ln in small.text.split("\n")[1:]:
        cells = ln.split("\t")
        assert cells[0].startswith("c-") and cells[1] == sent[cells[0]] and cells[1].endswith("켠다.")
    assert small.ids == ids[:small.n]


def test_control_characters_removed_and_no_score_fields(w):
    _world(w, 1)
    with w.rd() as (con, c):
        res = read.render_cards(con, c, ["c-ctl"])
        cells = res.text.split("\n")[1].split("\t")
        assert len(cells) == 5 and cells[1] == "x는 탭과 개행이 있는 문장이다"
        d = read.get_node(con, c, "e:tool:x")
        blob = json.dumps([d, res.text, read.catalog(con, c)], ensure_ascii=False).lower()
        for bad in ("score", "relevance", "rank_score", "opportunity"):
            assert bad not in blob
        out = read.render_cards(con, c, ["c-00", "nope"], budget=0)
        assert out.n == 0 and out.text.startswith("#kb v1 seq=")
