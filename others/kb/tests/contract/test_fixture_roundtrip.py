"""fixture 왕복(계약 9장): 디스크의 저널 조각 + CAS 객체를 재생한 결과가 저장된 응답과 같다.

둘을 본다.
1. 디스크 파일만으로 재생한다(생성기와 무관). 모든 사례의 응답이 저장본과 같아야 한다. 이것이 재구축 시험이다.
2. 생성기가 지금 만드는 파일이 디스크와 같다(원천 코드와 fixture가 어긋나지 않았다).
"""
import hashlib
import json

import cfx_run as R
import gen_fixtures as G


def _load_world(kb_home, doc):
    ev = R.load_ledger(R.FIX / "ledger.ndjson")
    cas_objs = {p.name: p.read_bytes() for p in (R.FIX / "cas").iterdir()}
    m = doc["meta"]
    assert len(ev) == m["ledger_events"]
    return R.Replayed(kb_home, ev, cas_objs, m["export_after_seq"], m["now_ms"])


def test_replay_from_disk_equals_stored_responses(kb_home, requests_doc, stored):
    rp = _load_world(kb_home, requests_doc)
    bad = []
    try:
        app = R.build_app(rp.path)
        with R.fixed_clock(requests_doc["meta"]["now_ms"]), R.fake_registry():
            for case in requests_doc["cases"]:
                got = R.to_stored(case["id"], R.call(app, case))
                if got != stored(case["id"]):
                    bad.append(case["id"])
    finally:
        rp.close()
    assert not bad, f"저장된 응답과 다른 사례 {len(bad)}개: {bad[:10]}"


def test_every_stored_response_has_a_case(requests_doc):
    ids = {c["id"] for c in requests_doc["cases"]}
    files = {p.stem for p in (R.FIX / "responses").glob("*.json")}
    assert ids == files
    assert len(ids) == len(requests_doc["cases"]), "사례 id가 겹친다"
    for c in requests_doc["cases"]:
        assert json.loads((R.FIX / "responses" / f"{c['id']}.json").read_text(encoding="utf-8"))["status"] == c["status"]


def test_cas_object_names_are_content_hashes():
    n = 0
    for p in (R.FIX / "cas").iterdir():
        assert hashlib.sha256(p.read_bytes()).hexdigest() == p.name
        n += 1
    assert n >= 10


def test_ledger_replay_is_deterministic(kb_home, requests_doc):
    """같은 입력이면 build_id가 같다(재생 입력의 해시). 응답에 박힌 값과도 같다."""
    rp = _load_world(kb_home, requests_doc)
    try:
        from kb.core import ledger
        from kb.project import build_id_of
        bid = build_id_of(rp.led)
        meta = json.loads((R.FIX / "responses" / "meta-ok.json").read_text(encoding="utf-8"))["body"]
        assert meta["build_id"] == bid and bid.startswith("g-")
        assert ledger.verify_chain(rp.led).ok
    finally:
        rp.close()


def test_generator_output_equals_disk(kb_home):
    files = G.generate(kb_home / "gen")
    diff = G.diff_fixtures(files, R.FIX)
    assert not diff, "생성기 출력이 디스크와 다르다(ops/bin/dev python tests/contract/gen_fixtures.py --write): " + "; ".join(diff[:10])
