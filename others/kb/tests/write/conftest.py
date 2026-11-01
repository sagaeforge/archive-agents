import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # wrhelp: 패키지로 만든 뒤에도 같은 이름으로 부른다

import pytest

from kb.core import ledger
from kb.project import rebuild


@pytest.fixture
def wk(kb_home, monkeypatch):
    """빈 원장 + 첫 gold가 있는 임시 KB_HOME. 설정 폴더도 임시다."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return kb_home


@pytest.fixture
def fp_open(wk):
    from wrhelp import open_fp_direct
    open_fp_direct()
    return wk
