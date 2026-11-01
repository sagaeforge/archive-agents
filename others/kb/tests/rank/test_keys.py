"""벡터 키는 공개 ID이고 재구축 뒤 같은 행을 가리킨다. secret, private은 벡터가 되지 않는다."""
import re

from kb.core.ids import check_public_id
from kb.rank import conf, indexer, store

from .conftest import build_vec, rhelp

PASSAGE = re.compile(r"[A-Za-z0-9_-]+:\d+")


def _index():
    return store.Index(store.current_root())


def test_keys_are_public_ids_and_no_private(w, kb_home):
    r = build_vec(w, kb_home)
    assert r["ok"] and r["rows"] > 0
    ix = _index()
    assert ix.dim == conf.DIM and ix.meta["dtype"] == "int8" and len(ix.ids) == ix.n
    for i, k in zip(ix.ids, ix.kinds):
        if k == "p":
            assert PASSAGE.fullmatch(i), i
        else:
            check_public_id(i)
    assert {"c", "r", "e", "p"} <= set(ix.kinds)
    assert "f-01JC8ZQ3T9PRV" not in ix.ids and "f-01JC8ZQ3T9SEC" not in ix.ids   # private, secret 벡터 0
    assert "f-01JC8ZQ3T9XYZ" in ix.ids                                          # internal은 들어간다


def test_rebuild_points_to_same_rows(w, kb_home):
    build_vec(w, kb_home)
    a = _index()
    first = {i: (k, s, a.row(n)) for n, (i, k, s) in enumerate(zip(a.ids, a.kinds, a.shas))}
    build_vec(w, kb_home, name="g-000000002-bbbb", full=True)    # 전체 재구축
    b = _index()
    assert b.build != a.build
    second = {i: (k, s, b.row(n)) for n, (i, k, s) in enumerate(zip(b.ids, b.kinds, b.shas))}
    assert first == second                                       # 같은 ID -> 같은 종류, 내용, 벡터


def test_incremental_reuses_rows(w, kb_home):
    r1 = build_vec(w, kb_home)
    r2 = build_vec(w, kb_home)                                   # 같은 gold 빌드: 건너뜀
    assert r2["skipped"] == "unchanged"
    w.add(rhelp.claim("c-ak2p4q7m1xad", "e:platform:youtube", PARAS3, snap_id="n-1"))
    r3 = build_vec(w, kb_home, name="g-000000003-cccc")
    assert r3["embedded"] >= 1 and r3["rows"] > r1["rows"]
    assert r3["embedded"] < r3["rows"]                           # 나머지는 재사용


PARAS3 = "썸네일 클릭률은 노출 대비 클릭 비율이다."


def test_dry_run_writes_nothing(w, kb_home):
    from kb.commands.index import run_index
    from .conftest import publish_gold
    publish_gold(w, kb_home, "g-000000001-aaaa")
    out = run_index(dry_run=True)
    assert out["dry_run"] and out["to_embed"] > 0
    assert not (kb_home / "derived" / "vec").exists() or not list((kb_home / "derived" / "vec").glob("v-*"))


def test_npy_is_numpy_compatible(w, kb_home):
    import pytest
    np = pytest.importorskip("numpy")
    build_vec(w, kb_home)
    m = np.load(store.current_root() / "vectors.npy")
    assert m.dtype == np.int8 and m.shape[1] == conf.DIM


def test_prune_keeps_current(w, kb_home):
    for n, name in enumerate(("g-000000001-aaaa", "g-000000002-bbbb", "g-000000003-cccc", "g-000000004-dddd")):
        build_vec(w, kb_home, name=name, full=True)
    dirs = [d.name for d in (kb_home / "derived" / "vec").iterdir() if d.name.startswith("v-")]
    assert len(dirs) <= 2 and store.current_root().name in dirs
