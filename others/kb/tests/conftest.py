import os
import shutil
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def kb_home(monkeypatch):
    """$KB_HOME/test-tmp/ 아래 임시 폴더(디스크). /tmp는 tmpfs라 쓰지 않는다."""
    prod = Path("/home/user/sagae-kb-data").resolve()
    env = os.environ.get("KB_HOME")
    root = Path(env).resolve() if env else None
    if root is None or root == prod or prod in root.parents:
        build = os.environ.get("KB_BUILD_ROOT") or str(Path.home() / ".cache/sagae-kb/build")
        root = Path(build) / "pytest-default"
    base = root / "test-tmp" / "pytest"
    d = base / uuid.uuid4().hex[:12]
    d.mkdir(parents=True)
    monkeypatch.setenv("KB_HOME", str(d))
    monkeypatch.delenv("KB_SHARE", raising=False)
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def repo():
    return REPO
