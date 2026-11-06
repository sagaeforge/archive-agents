import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))  # arhelp

REPO = Path(__file__).resolve().parents[2]


def _base() -> Path:
    prod = Path("/home/user/sagae-kb-data").resolve()
    env = os.environ.get("KB_HOME")
    root = Path(env).resolve() if env else None
    if root is None or root == prod or prod in root.parents:
        build = os.environ.get("KB_BUILD_ROOT") or str(Path.home() / ".cache/sagae-kb/build")
        root = Path(build) / "pytest-default"
    return root / "test-tmp" / "pytest-agentrun"


@pytest.fixture
def home(monkeypatch):
    """임시 KB_HOME(디스크) + 빈 설정 폴더 + 저장소를 가리키는 KB_SHARE."""
    d = _base() / uuid.uuid4().hex[:12]
    d.mkdir(parents=True)
    monkeypatch.setenv("KB_HOME", str(d))
    (d / "config").mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(d / "config"))
    monkeypatch.setenv("KB_SHARE", str(REPO))
    for k in ("KB_LIVE", "KB_CLAUDE_BIN", "KB_BIN", "KB_AGENT_RUN"):
        monkeypatch.delenv(k, raising=False)
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def repo():
    return REPO


@pytest.fixture
def kbenv(home):
    """원장과 gold가 있는 임시 KB_HOME. 공유 폴더는 저장소의 schemas, sources를 가리킨다. 사실 기록(fp)은 열려 있다."""
    from kb.core import ledger
    from kb.project import rebuild
    share = home / "share"
    share.mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources").symlink_to(REPO / "sources")
    os.environ["KB_SHARE"] = str(share)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    from kb.write import commit
    commit([{"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system", "subject": "fp",
             "idem_key": "fp-opened:test", "payload": {"mode": "drill"}}])
    sys.path.insert(0, str(REPO / "tests" / "mcp"))
    return home
