"""_seen_spans: 창에 한 번만 실린 반복 문단의 다른 사본도 모델이 본 구간으로 센다."""
from types import SimpleNamespace as NS

from kb.extract import runner


def test_identical_paragraph_copies_all_count_as_seen():
    paras = [NS(start_cp=0, end_cp=10, para_sha="a"), NS(start_cp=12, end_cp=20, para_sha="b"),
             NS(start_cp=22, end_cp=32, para_sha="a")]
    proc = NS(text_of=lambda x: x, snapshot_info=lambda sid: NS(paras=paras))
    w = NS(snapshot="s", para_shas=["a"], spans=[(0, 10)])
    assert runner._seen_spans(proc, w) == [(0, 10), (22, 32)]
