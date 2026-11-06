"""스케줄러 유닛과 Windows 작업의 정적 검사."""
import configparser
import subprocess
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
SD = ROOT / "ops/systemd"
NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}


def text(name):
    return (SD / name).read_text()


def cfg(name):
    p = configparser.ConfigParser(strict=False, interpolation=None)
    p.optionxform = str
    p.read_string(text(name))
    return p


def test_no_persistent():
    for f in SD.iterdir():
        assert "Persistent=" not in f.read_text(), f.name


def test_tick():
    t = cfg("kb-tick.timer")["Timer"]
    assert t["OnStartupSec"] == "90s"
    assert t["OnUnitInactiveSec"] == "15min"
    assert t["AccuracySec"] == "30s"
    s = cfg("kb-tick.service")["Service"]
    assert s["Type"] == "oneshot"
    assert s["TimeoutStartSec"] == "14min"
    assert s["ExecStart"] == "%h/sagae-kb-data/runtime/bin/kb tick --max-runtime 12m"


def test_agent():
    t = cfg("kb-agent.timer")["Timer"]
    assert t["OnStartupSec"] == "10min"
    assert t["OnUnitInactiveSec"] == "1h"
    s = cfg("kb-agent.service")["Service"]
    assert s["Type"] == "oneshot"
    assert s["ExecStart"].endswith("/runtime/bin/kb jobs run")
    assert s["TimeoutStartSec"] == "2h"


def test_read():
    assert cfg("kb-read.service")["Unit"]["StartLimitIntervalSec"] == "0"
    assert cfg("kb-read.service")["Unit"]["Requires"] == "kb-read.socket"
    s = cfg("kb-read.socket")["Socket"]
    assert s["ListenStream"] == "%h/sagae-kb-data/run/read.sock"
    assert s["SocketMode"] == "0600"
    assert s["Accept"] == "no"
    assert "127.0.0.1" not in text("kb-read.socket")
    assert "8737" not in text("kb-read.socket")
    tcp = cfg("kb-read-tcp.socket")["Socket"]
    assert tcp["ListenStream"] == "127.0.0.1:8737"
    assert tcp["Service"] == "kb-read.service"


def test_windows_xml():
    r = etree.parse(str(ROOT / "ops/windows/kb-tick.xml")).getroot()
    g = lambda p: r.find(p, NS).text
    assert g(".//t:StartWhenAvailable") == "true"
    assert g(".//t:MultipleInstancesPolicy") == "IgnoreNew"
    assert g(".//t:ExecutionTimeLimit") == "PT1H"
    assert g(".//t:WakeToRun") == "false"
    assert g(".//t:LogonTrigger/t:Repetition/t:Interval") == "PT6H"
    assert r.find(".//t:Principal/t:LogonType", NS).text == "InteractiveToken"
    args = g(".//t:Exec/t:Arguments")
    assert "kb tick --until-idle --max-runtime 45m" in args
    assert g(".//t:Exec/t:Command") == "wsl.exe"


def test_install_dry_run_has_no_side_effects(tmp_path):
    r = subprocess.run(["bash", str(ROOT / "ops/bin/install-units.sh")],
                       capture_output=True, text=True, env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"})
    assert r.returncode == 0
    assert all(l.startswith(("DRY:", "#")) for l in r.stdout.splitlines()), r.stdout
    assert not (tmp_path / ".config").exists()
    assert "kb-read-tcp" not in r.stdout
    r2 = subprocess.run(["bash", str(ROOT / "ops/bin/install-units.sh"), "--with-tcp"],
                        capture_output=True, text=True, env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"})
    assert "kb-read-tcp.socket" in r2.stdout
