"""머신 밖 항목: 대상이 없으면 offsite_age 경보 없이 offsite_missing 안내만. 대상 설정 뒤 치명으로 전환. tick 단계 등록."""
import yaml

from kb.guard import tick_stage_watch, watchdog
from kb.core import opsdb
from conftest import NOW, codes

DAY_MS = 86_400_000


def targets(env, *, offsite=True):
    t = [{"id": "local1", "kind": "local", "repo": str(env.home / "restic-local")}]
    if offsite:
        t.append({"id": "ssd", "kind": "external_drive", "repo": "/mnt/e/kb-restic"})
    (env.cfg / "targets.yaml").write_text(yaml.safe_dump({"targets": t}))


def test_unconfigured_offsite_is_notice_only(env, ops):
    opsdb.tick_state_set(ops, "ship.ok.local1.t0", NOW - 30 * DAY_MS)   # 로컬 대상이 아무리 오래됐어도 머신 밖 경보가 아니다
    targets(env, offsite=False)
    v = watchdog.compute(NOW, uptime=0)
    assert "offsite_missing" in codes(v["notices"])
    assert not any(c.startswith("offsite_age") for c in codes(v["critical"]))
    assert "offsite_age" not in codes(v["warnings"])


def test_configured_offsite_age_turns_critical(env, ops):
    targets(env)
    opsdb.tick_state_set(ops, "ship.ok.ssd.t0", NOW - 2 * DAY_MS)       # T0 한도 1일 초과
    opsdb.tick_state_set(ops, "ship.ok.ssd.t1", NOW - 1 * DAY_MS)       # T1 한도 3일 이내
    v = watchdog.compute(NOW, uptime=0)
    hits = [x for x in v["critical"] if x["code"] == "offsite_age"]
    assert [(x["target"], x["tier"]) for x in hits] == [("ssd", "t0")]
    assert "offsite_missing" not in codes(v["notices"])


def test_unmounted_is_notice_and_age_still_critical(env, ops):
    targets(env)
    opsdb.tick_state_set(ops, "ship.unavailable.ssd", "not_mounted")
    opsdb.tick_state_set(ops, "ship.ok.ssd.t0", NOW - 5 * DAY_MS)
    v = watchdog.compute(NOW, uptime=0)
    assert "offsite_unmounted" in codes(v["notices"])
    assert "offsite_age" in codes(v["critical"])


def test_pre_decision_notices(env):
    v = watchdog.compute(NOW, uptime=0)
    n = codes(v["notices"])
    for c in ("offsite_missing", "boot_path_unverified", "schedule_missing", "single_copy", "mcp_unregistered"):
        assert c in n
    assert v["critical"] == []


def test_stage_registration_and_state_keys(env):
    assert [(n, name) for n, name, _ in tick_stage_watch.STAGES] == [(6.5, "checkpoint"), (8, "watchdog")]
    r = tick_stage_watch.run_watchdog()
    assert r.ok
    c = opsdb.connect()
    try:
        ts = {k: v for k, v in c.execute("SELECT k, v FROM tick_state")}
    finally:
        c.close()
    # WP-04 envelope.degraded가 읽는 키 이름
    assert ts["boot_path_unverified"] == "1" and ts["stale_build"] == "0"
    assert ts["ledger_head_seq"] == "" and ts["behind_since_ms"] == ""
