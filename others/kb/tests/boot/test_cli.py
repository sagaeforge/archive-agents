import json
import os
import subprocess
import sys

from kb import cli


def test_broken_command_module_does_not_block(tmp_path, monkeypatch, capsys):
    import kb.commands as pkg

    d = tmp_path / "cmds"
    d.mkdir()
    (d / "aaa_broken.py").write_text("raise RuntimeError('boom')\n")
    (d / "bbb_noreg.py").write_text("x = 1\n")
    (d / "ccc_ok.py").write_text(
        "def register(sub):\n"
        "    p = sub.add_parser('hello')\n"
        "    p.set_defaults(func=lambda a: 7)\n"
    )
    monkeypatch.setattr(pkg, "__path__", list(pkg.__path__) + [str(d)])
    sys.modules.pop("kb.commands.aaa_broken", None)
    rc = cli.main(["hello"])
    err = capsys.readouterr().err
    assert rc == 7
    assert "aaa_broken" in err and "bbb_noreg" in err


def test_doctor_ok(kb_home):
    r = subprocess.run([sys.executable, "-m", "kb", "doctor", "--json"], capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert r.returncode == 0 and out["ok"] is True


def test_doctor_fs_rejected():
    env = dict(os.environ, KB_HOME="/tmp/x")
    r = subprocess.run([sys.executable, "-m", "kb", "doctor", "--json"], capture_output=True, text=True, env=env)
    out = json.loads(r.stdout)
    assert r.returncode == 1 and out["code"] == "fs_rejected"


def test_perf_marker_excluded(repo):
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", str(repo / "tests/boot/perf_probe")],
        capture_output=True, text=True, cwd=repo,
    )
    assert "deselected" in r.stdout and "1 passed" not in r.stdout
