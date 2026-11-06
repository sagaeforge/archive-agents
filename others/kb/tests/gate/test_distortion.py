"""왜곡 고정 표본 90건(+대조군 38건, 인용구 변조 49건)이 게이트를 지나는 수. subject 필드는 원래 값을 유지한다.
표본 생성기: tests/gate/make_distortion.py. 생성 규칙이 바뀌면 이 시험이 먼저 깨진다."""
import json
import subprocess
import sys
from collections import Counter

from . import helpers as H

DIST = ("부정 반전", "비교 반전", "단위 교체", "주어 교체", "숫자 교차")


def _results():
    rows = H.rows()
    data = json.loads((H.DATA / "distortion.json").read_text(encoding="utf-8"))
    out = []
    for d in data:
        out.append((d, H.run(rows[d["row"]], d["statement"], d["quote"])))
    return out


def test_sample_counts_and_subject_kept():
    rows = H.rows()
    data = json.loads((H.DATA / "distortion.json").read_text(encoding="utf-8"))
    n = Counter(d["cat"] for d in data)
    assert sum(n[c] for c in DIST) == 90
    assert n["주어 교체"] == 35 and n["숫자 변경(대조군)"] == 38
    for d in data:
        assert d["subject"] == rows[d["row"]]["subject"]        # 바뀐 이름을 subject로 넘기지 않는다


def test_fixture_matches_generator():
    r = subprocess.run([sys.executable, str(H.DATA.parent / "make_distortion.py"), "--check"], capture_output=True)
    assert r.returncode == 0, "distortion.json이 생성기 출력과 다르다"


def test_distortions_pass_at_most_20_of_90():
    res = _results()
    passed = [d["cat"] for d, r in res if d["cat"] in DIST and r.accepted]
    assert len(passed) <= 20, Counter(passed)


def test_subject_swap_passes_at_most_5_of_35():
    res = _results()
    assert sum(1 for d, r in res if d["cat"] == "주어 교체" and r.accepted) <= 5


def test_numeric_control_passes_zero_of_38():
    res = _results()
    ctl = [(d, r) for d, r in res if d["cat"] == "숫자 변경(대조군)"]
    assert len(ctl) == 38 and not [d["statement"] for d, r in ctl if r.accepted]


def test_tampered_quotes_all_rejected():
    res = _results()
    tam = [(d, r) for d, r in res if d["cat"] == "인용구 변조"]
    assert len(tam) == 49
    bad = [d["quote"][:40] for d, r in tam if not r.rejected]
    assert not bad, bad
    assert {r.code for d, r in tam} <= {"E_QUOTE_NOT_FOUND", "E_QUOTE_AMBIGUOUS", "E_QUOTE_SHORT"}
