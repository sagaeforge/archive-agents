"""낡은 전제 주석: 활성 event 주장의 귀속 문장만 렌더링한다. 근거 없는 주장과 superseded 값은 렌더링 0건."""
from kb import read
from .rhelp import E, T0, claim, entity, snap


def _card(w, cid):
    with w.rd() as (con, c):
        res = read.render_cards(con, c, [cid])
    return res.text.split("\n")[1].split("\t")[1] if res.n else None


def _base(w):
    w.add(entity("e:tool:x", "X"), snap("n-1", source="src:cc-docs"),
          claim("c-prem", "e:tool:x", "x는 위젯 명령을 지원한다", "state"))


def test_attribution_sentence_from_active_event(w):
    _base(w)
    w.add(claim("c-ev", "e:tool:x", "x의 위젯 명령은 2.1.222에서 제거됐다", "event", valid={"from": "2027-01-01"}))
    s = _card(w, "c-prem")
    assert s == "x는 위젯 명령을 지원한다 (출처 cc-docs에 따르면 x의 위젯 명령은 2.1.222에서 제거됐다)"
    assert _card(w, "c-ev") == "x의 위젯 명령은 2.1.222에서 제거됐다"  # event 자신에는 붙지 않는다


def test_no_annotation_without_evidence_or_for_superseded_or_old(w):
    _base(w)
    w.add(claim("c-nr", "e:tool:x", "x는 곧 사라진다는 소문이 있다", "event", valid={"from": "2027-01-01"}, verification="needs_review"))
    w.add(claim("c-old", "e:tool:x", "x의 위젯은 2010년에 바뀌었다", "event", valid={"from": "2010-01-01"}))
    assert _card(w, "c-prem") == "x는 위젯 명령을 지원한다"  # 근거 없는 주장, 24개월 밖
    w.add(claim("c-ev", "e:tool:x", "x의 위젯 명령은 제거됐다", "event", valid={"from": "2027-01-01"}))
    assert "제거됐다" in _card(w, "c-prem")
    w.add(E("claim.retract", {"id": "c-ev"}, "c-ev"))  # dead
    assert _card(w, "c-prem") == "x는 위젯 명령을 지원한다"
    w.add(claim("c-ev2", "e:tool:x", "x의 위젯은 대체됐다", "event", valid={"from": "2027-01-01"}))
    w.add(E("claim.supersede", {"id": "c-ev2", "by": "c-old"}, "c-ev2"))
    assert _card(w, "c-prem") == "x는 위젯 명령을 지원한다"  # superseded 값은 0건
    with w.rd() as (con, c):
        text = read.render_cards(con, c, ["c-prem", "c-ev", "c-ev2"]).text
    assert "대체됐다" not in text and "제거됐다" not in text
