import os
import subprocess
import tarfile
from pathlib import Path


def sh(repo, script, env=None, cwd=None):
    e = {"PATH": "/usr/bin:/bin", "HOME": os.environ["HOME"]}
    e.update(env or {})
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=e, cwd=cwd or repo)


def test_wp_env_package_values(repo, tmp_path):
    r = sh(repo, 'source ops/bin/wp-env.sh WP-05; echo $KB_HOME $KB_CONFIG_DIR $KB_TMP $KB_TOOLCHAIN $KB_BUILD_ROOT',
           {"HOME": str(tmp_path)})
    b = f"{tmp_path}/.cache/sagae-kb/build"
    assert r.stdout.split() == [f"{b}/WP-05", f"{b}/WP-05/config", f"{b}/WP-05/test-tmp/WP-05",
                                "/home/user/sagae-kb-data/runtime", b]
    assert (Path(b) / "WP-05/test-tmp/WP-05").is_dir()


def test_wp_env_live_values(repo, tmp_path):
    for args in ("WP-21", "WP-25", "WP-26", "WP-14 --live"):
        r = sh(repo, f'source ops/bin/wp-env.sh {args}; echo $KB_HOME $KB_CONFIG_DIR', {"HOME": str(tmp_path)})
        assert r.stdout.split() == ["/home/user/sagae-kb-data", f"{tmp_path}/.config/sagae-kb"], args
    r = sh(repo, 'source ops/bin/wp-env.sh WP-14; echo $KB_HOME', {"HOME": str(tmp_path)})
    assert "/WP-14" in r.stdout


def test_env_defaults(repo, tmp_path):
    r = sh(repo, 'source ops/bin/env.sh; echo $KB_HOME $KB_TOOLCHAIN $UV_PYTHON_INSTALL_DIR $UV_PYTHON_DOWNLOADS "[$KB_CLAUDE_BIN]"',
           {"HOME": str(tmp_path)})
    assert r.stdout.split() == ["/home/user/sagae-kb-data", "/home/user/sagae-kb-data/runtime",
                                "/home/user/sagae-kb-data/runtime/python", "manual", "[]"]
    r = sh(repo, 'source ops/bin/env.sh; echo $KB_TOOLCHAIN', {"HOME": str(tmp_path), "KB_HOME": "/x/y"})
    assert r.stdout.strip() == "/x/y/runtime"


def test_report_incident(repo, tmp_path):
    root = tmp_path / "b"
    r = sh(repo, 'ops/bin/report-incident WP-00 other "한글 detail"', {"KB_BUILD_ROOT": str(root)})
    assert r.returncode == 0, r.stderr
    import json
    rec = json.loads((root / "incidents.ndjson").read_text().splitlines()[0])
    assert rec["wp"] == "WP-00" and rec["kind"] == "other" and rec["detail"] == "한글 detail"


def test_deploy_dry_run(repo, tmp_path):
    r = sh(repo, "ops/bin/deploy --dry-run", {"KB_HOME": str(tmp_path / "kb")})
    assert r.returncode == 0, r.stderr
    assert f"{tmp_path}/kb/runtime/venv" in r.stdout and f"{tmp_path}/kb/runtime/share" in r.stdout
    assert not (tmp_path / "kb").exists()


def test_deploy_from_snapshot_and_generations(repo, kb_home):
    """스냅샷 배포, 래퍼 값, 세대 보존(현재 + 옛 2세대)."""
    src = kb_home / "src-tree"
    (src / "src/kb").mkdir(parents=True)
    for rel in ("pyproject.toml", "uv.lock", ".python-version"):
        (src / rel).write_bytes((repo / rel).read_bytes())
    for f in (repo / "src/kb").rglob("*.py"):
        t = src / f.relative_to(repo)
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_bytes(f.read_bytes())
    (src / "schemas").mkdir()
    ids = []
    env = {"KB_HOME": str(kb_home / "kb"), "KB_CONFIG_DIR": str(kb_home / "cfg"), "KB_TMP": str(kb_home / "tmp")}
    for n in range(4):
        (src / "schemas/v.txt").write_text(str(n))
        snap = kb_home / f"s{n}.tar.gz"
        with tarfile.open(snap, "w:gz") as t:
            for p in sorted(src.iterdir()):
                t.add(p, arcname=p.name)
        r = sh(repo, f"ops/bin/deploy --from-snapshot {snap}", env)
        assert r.returncode == 0, r.stdout + r.stderr
        ids.append([l for l in r.stdout.splitlines() if l.startswith("id: ")][0][4:])
    rt = kb_home / "kb/runtime"
    assert len(set(ids)) == 4
    assert (rt / "venv").resolve().name == f"venv-{ids[3]}"
    assert (rt / "share").resolve().name == f"share-{ids[3]}"
    assert (rt / "share/schemas/v.txt").read_text() == "3"
    left = sorted(p.name for p in rt.glob("venv-*"))
    assert left == sorted(f"venv-{i}" for i in ids[1:])
    wrapper = (rt / "bin/kb").read_text()
    assert "KB_SHARE" in wrapper and "KB_CLAUDE_BIN" in wrapper and "-I" in wrapper
    r = subprocess.run([str(rt / "bin/kb"), "doctor", "--json"], capture_output=True, text=True,
                       cwd="/", env={"PATH": "/usr/bin:/bin", "HOME": os.environ["HOME"]})
    assert r.returncode == 0, r.stdout + r.stderr
    import json
    assert json.loads(r.stdout)["share_dir"] == str(rt / "share")
