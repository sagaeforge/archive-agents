"""L2 창 안 해소: windows는 submit의 대역 밖 인자다. 묶음 안의 값으로는 좁혀지지 않고, 창 없는 경로는 이전과 같다."""
from kb import ingest

from .conftest import bundle, capture, res
from .test_claims import DOC, cl, ent, snap  # noqa: F401  (snap 고정물 재사용)

TEXT = DOC.decode()


def _win(needle):
    a = TEXT.index(needle)
    return [(a, a + len(needle))]


def _items(snap):
    return [ent(), cl(snap, "Widget Toolkit", "Widget Toolkit is mentioned in CI advice.")]


def test_submit_with_window_resolves_unique_hit(env, snap):
    sentence = "pin the version of Widget Toolkit in CI"
    rep = ingest.submit(bundle(_items(snap), producer="agent:l2"), fetch=False, windows={snap: _win(sentence)})
    r = res(rep, "c1")
    assert r["result"] in ("accepted", "needs_review") and r.get("code") != "E_QUOTE_AMBIGUOUS"


def test_submit_without_window_still_ambiguous(env, snap):
    rep = ingest.submit(bundle(_items(snap), producer="agent:l2"), fetch=False)
    assert res(rep, "c1")["code"] == "E_QUOTE_AMBIGUOUS"


def test_window_in_bundle_item_is_ignored(env, snap):
    it = cl(snap, "Widget Toolkit", "Widget Toolkit is mentioned in CI advice.")
    it["evidence"]["window"] = _win("pin the version of Widget Toolkit in CI")
    it["window"] = _win("pin the version of Widget Toolkit in CI")
    rep = ingest.submit(bundle([ent(), it], producer="agent:kb-collector"), fetch=False)
    assert res(rep, "c1")["code"] in ("E_QUOTE_AMBIGUOUS", "E_SCHEMA")


def test_window_with_two_hits_stays_ambiguous(env, snap):
    win = _win("The Widget Toolkit stores 5 widgets per page.") + _win("pin the version of Widget Toolkit in CI")
    rep = ingest.submit(bundle(_items(snap), producer="agent:l2"), fetch=False, windows={snap: win})
    assert res(rep, "c1")["code"] == "E_QUOTE_AMBIGUOUS"
