"""sLLM 수명 주기: 배치 뒤 프로세스 0, 부모가 죽어도 남지 않음, 큐가 비면 시작 0, VRAM 6,144 MiB 미만이면 건너뜀, 서버는 이름공간 안에서만."""
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from kb.core import opsdb
from kb.extract import runner, settings
from kb.extract.backends import sllm

from . import helpers as H


@pytest.fixture
def fake(tmp_path):
    p = H.make_fake_llama(tmp_path / "ll")
    ov = {"sllm.server_bin": str(p), "sllm.model_file": str(p.parent / "model.gguf"), "sllm.vram_cmd": ["echo", "9000"],
          "sllm.netns": False, "sllm.port": 18931, "sllm.health_wait_s": 20, "sllm.term_wait_s": 5}
    with settings.override(**ov):
        yield p.parent


def pid(d: Path) -> int:
    return int((d / "pid").read_text())


def test_process_zero_after_batch(env, fake):
    with sllm.Session() as s:
        assert s.started
        p = pid(fake)
        assert H.pid_alive(p)
        r = sllm.Sllm(port=18931).extract(_job(), None)
        assert r.error is None and r.raw is not None and r.provider == "local" and r.cost_usd == 0.0
    assert not H.pid_alive(p)
    c = opsdb.connect()
    try:
        left = c.execute("SELECT value FROM metric WHERE name='llm.sllm_residual_procs'").fetchall()
    finally:
        c.close()
    assert left and left[-1][0] == 0


def _job():
    from kb.extract import schema
    from kb.extract.types import Job, Window
    w = Window("w", "n-1", "본문", [], [])
    return Job(w, "extract", "sensitive", "sys", "user", schema.extract_schema([]), "nemotron")


def test_server_flags(env, fake):
    import json
    with sllm.Session():
        a = json.loads((fake / "argv.json").read_text())
    assert a[a.index("--host") + 1] == "127.0.0.1" and a[a.index("-ngl") + 1] == "999" and a[a.index("-c") + 1] == "16384"
    assert "--no-context-shift" in a and a[a.index("--reasoning") + 1] == "off" and a[a.index("-cram") + 1] == "0"


def test_empty_think_block_appended(env, fake):
    import json
    with sllm.Session():
        sllm.Sllm(port=18931).extract(_job(), None)
    reqs = [json.loads(x) for x in (fake / "reqs.jsonl").read_text().splitlines()]
    comp = [r for r in reqs if r["path"] == "/completion"][0]["body"]
    assert comp["prompt"].endswith("<think>\n\n</think>\n\n") and comp["json_schema"] and comp["temperature"] == 0


def test_parent_death_leaves_no_server(env, fake, tmp_path):
    code = ("import time, os\n"
            "from kb.extract import settings\n"
            "from kb.extract.backends import sllm\n"
            f"ov = {dict(((k, v) for k, v in settings._OVERRIDE.items()))!r}\n"
            "settings._OVERRIDE.update(ov)\n"
            "s = sllm.Session(); assert s.start()\n"
            "print('up', flush=True); time.sleep(60)\n")
    child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True, env=dict(os.environ))
    assert child.stdout.readline().strip() == "up"
    p = pid(fake)
    assert H.pid_alive(p)
    child.send_signal(signal.SIGKILL)
    child.wait()
    for _ in range(40):
        if not H.pid_alive(p):
            break
        time.sleep(0.1)
    assert not H.pid_alive(p)                                  # 부모가 죽어도 남지 않는다


def test_vram_below_threshold_skips_and_records(env, fake):
    with settings.override(**{"sllm.vram_cmd": ["echo", "6143"]}):
        with sllm.Session() as s:
            assert not s.started and s.skipped == "vram"
    assert not (fake / "starts").exists()                      # 띄우지 않았다
    c = opsdb.connect()
    try:
        m = c.execute("SELECT dims FROM metric WHERE name='llm.sllm_skipped'").fetchall()
    finally:
        c.close()
    assert m and "vram" in m[0][0]
    with settings.override(**{"sllm.vram_cmd": ["echo", "6144"]}):
        with sllm.Session() as s:
            assert s.started                                    # 6,144는 통과


def test_empty_queue_starts_nothing(env, fake, monkeypatch):
    import kb.write.fpgate as fp
    monkeypatch.setattr(fp, "is_open", lambda: True)
    out = runner.run_agent("sensitive", backends={"sllm": sllm.Sllm(port=18931)})
    assert out["windows"] == 0 and out["reason"] == "queue_empty"
    assert not (fake / "starts").exists()


def test_fp_closed_does_nothing(env, fake, monkeypatch):
    import kb.write.fpgate as fp
    monkeypatch.setattr(fp, "is_open", lambda: False)
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, "l2s", "r-1|0|0")
    finally:
        c.close()
    out = runner.run_agent("sensitive", backends={"sllm": sllm.Sllm(port=18931)})
    assert out["windows"] == 0 and out["reason"] == "fp_closed" and not (fake / "starts").exists()


def test_server_only_inside_namespace(env, fake, tmp_path):
    """이름공간 안에서 뜬 서버는 바깥에서 닿지 않는다. 안에서는 lo만 있다."""
    probe = tmp_path / "probe.py"
    probe.write_text("import subprocess, sys\n"
                     "n = subprocess.run(['sh','-c','ip -o link show | wc -l'], capture_output=True, text=True).stdout.strip()\n"
                     "from kb.extract import settings\n"
                     "from kb.extract.backends import sllm\n"
                     f"settings._OVERRIDE.update({settings._OVERRIDE!r})\n"
                     "s = sllm.Session()\n"
                     "ok = s.start()\n"
                     "import json; print(json.dumps({'links': n, 'ok': ok}), flush=True)\n"
                     "import time; time.sleep(4)\n"
                     "s.stop()\n")
    p = subprocess.Popen(sllm.netns_argv([sys.executable, str(probe)]), stdout=subprocess.PIPE, text=True,
                         env=dict(os.environ, **{sllm.IN_NETNS_ENV: "1"}))
    import json
    first = json.loads(p.stdout.readline())
    assert first["links"] == "1" and first["ok"]                # lo뿐
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", 18931), timeout=1)    # 바깥에서는 닿지 않는다
    p.wait(timeout=30)
