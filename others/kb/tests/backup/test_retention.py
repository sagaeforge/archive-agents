"""retention별 저장 위치와 전송 계층. raw/ttl은 어떤 대상에도 가지 않는다."""
import json

from bkhelp import local_spec, offsite_spec, open_fp
from kb.core import cas
from kb.guard import ship


def _paths(t, sec, *tags):
    out = []
    for tag in tags:
        a = ["ls", "latest", "--host", "kb", "--tag", tag]
        out += ship.run_restic(t, a, sec).stdout.splitlines()
    return "\n".join(out)


def test_tier_by_retention_and_ttl_never_leaves(bk):
    h = bk.home
    (h / "fake-e").mkdir()
    bk.write_config([local_spec(h), offsite_spec(h)])
    bk.set_mount(str(h / "fake-e"))
    bk.init()
    open_fp()
    perm = cas.put(b"permanent object", "objects")      # retention permanent: raw/objects, 원장
    fpb = cas.put(b"first party body", "fp")             # 64KB 초과 first_party 본문: raw/fp
    ttl = cas.put(b"ttl30 / purgeable object", "ttl")   # ttl30, purgeable: raw/ttl
    assert cas.path_of(perm).parts[-3] == "objects" and cas.path_of(ttl, "ttl").parts[-3] == "ttl"
    assert all("/ttl" not in str(p) for tier in ship.TIERS for p in ship.tier_paths(tier))
    r = ship.ship()
    assert r["ok"]
    ts = {t.id: t for t in ship.load_targets()}
    sec = ship.load_secrets()
    for tid in ("local-c", "offsite-e"):
        t0 = _paths(ts[tid], sec, "t0")
        t1 = _paths(ts[tid], sec, "t1")
        assert f"/raw/fp/{fpb[:2]}/{fpb}" in t0
        assert f"/raw/objects/{perm[:2]}/{perm}" in t1 and f"/raw/objects/{perm[:2]}/{perm}" not in t0
        allp = _paths(ts[tid], sec, *(("t0", "t1", "t3") if tid == "local-c" else ("t0", "t1")))
        assert "/raw/ttl" not in allp and ttl not in allp
    # 머신 밖 대상은 T0, T1만 받는다. T3(ops.db)는 /mnt/c 쪽이다
    tags = {tag for s in json.loads(ship.run_restic(ts["offsite-e"], ["snapshots", "--json"], sec).stdout)
            for tag in s["tags"]}
    assert tags == {"t0", "t1"}
    tags_c = {tag for s in json.loads(ship.run_restic(ts["local-c"], ["snapshots", "--json"], sec).stdout)
              for tag in s["tags"]}
    assert tags_c == {"t0", "t1", "t3"}


def test_t1_t3_daily_t0_only_when_dirty(bk):
    h = bk.home
    bk.write_config([local_spec(h)])
    bk.init()
    open_fp()
    assert [x["tier"] for x in ship.ship()["targets"][0]["tiers"] if "tier" in x] == ["t0", "t1", "t3"]
    assert ship.ship(if_dirty=True).get("skipped") == "clean"
    open_fp  # noqa: B018
    from bkhelp import put
    put("a", "b")
    r = ship.ship(if_dirty=True)
    assert [x["tier"] for x in r["targets"][0]["tiers"]] == ["t0"]
    # 하루가 지나면 T1, T3가 다시 만기
    day = 86_400_000
    now = int(__import__("time").time() * 1000) + day + 1000
    pl = ship.plan(now)
    assert set(pl["targets"][0]["due"]) == {"t1", "t3"}
