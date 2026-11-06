import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEV = REPO / "ops/bin/dev"
PROD = "/home/user/sagae-kb-data"


def _run(env_extra, tmp_path):
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path)}
    env.update(env_extra)
    return subprocess.run([str(DEV), "true"], env=env, capture_output=True, text=True)


def test_refuses_prod_without_live(tmp_path):
    r = _run({"KB_HOME": PROD}, tmp_path)
    assert r.returncode != 0
    assert "KB_LIVE=1" in r.stderr


def test_default_is_not_prod(tmp_path):
    r = _run({}, tmp_path)
    assert "실운영" not in r.stderr


def test_wp_env_live_flag(tmp_path):
    def sh(wp):
        return subprocess.run(
            ["bash", "-c", f'. {REPO}/ops/bin/wp-env.sh {wp}; echo "${{KB_LIVE:-0}}"'],
            env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)},
            capture_output=True, text=True).stdout.strip().splitlines()[-1]
    assert sh("WP-21") == "1"
    assert sh("WP-05") == "0"
