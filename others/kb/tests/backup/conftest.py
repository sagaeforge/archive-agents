import itertools
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from bkhelp import Env, find_restic  # noqa: E402
from kb.core import ledger  # noqa: E402
from kb.project import rebuild  # noqa: E402


@pytest.fixture
def bk(kb_home, monkeypatch):
    """빈 원장 + 첫 gold + 임시 설정 폴더. restic이 없으면 건너뛴다. 외부로 나가는 것은 없다."""
    r = find_restic()
    if r is None:
        pytest.skip("restic 바이너리 없음")
    env = Env(kb_home, r)
    monkeypatch.setenv("KB_CONFIG_DIR", str(env.cfg))
    monkeypatch.setenv("KB_RESTIC_BIN", r)
    monkeypatch.setenv("KB_FINDMNT", env.fake_findmnt())
    monkeypatch.setenv("FAKE_FINDMNT_JSON", str(env.mnt_json))
    monkeypatch.delenv("FAKE_FINDMNT_RC", raising=False)
    monkeypatch.delenv("KB_FAIL_REPO", raising=False)
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return env


_n = itertools.count()


@pytest.fixture
def mk_ev():
    def f(kind="record.put", payload=None, subject=None, **kw):
        n = next(_n)
        return {"kind": kind, "actor": "user:sagae", "origin": "first_party", "subject": subject or f"f-t{n}",
                "idem_key": f"k{n}", "payload": payload or {"n": n}, **kw}
    return f


@pytest.fixture(scope="session", autouse=True)
def _drop_tpl():
    yield
    import bkhelp
    bkhelp.drop_template()
