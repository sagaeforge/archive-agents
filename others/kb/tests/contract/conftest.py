"""계약 시험 공용. 합성 fixture만 쓰고 실운영 경로와 전역 파일을 건드리지 않는다."""
import os
import sys
from pathlib import Path

import pytest

# hypothesis(Schemathesis)가 저장소 루트에 .hypothesis를 만들지 않게 디스크의 임시 폴더로 돌린다.
os.environ.setdefault("HYPOTHESIS_STORAGE_DIRECTORY", str(Path(os.environ.get("KB_TMP") or (
    Path(os.environ.get("KB_BUILD_ROOT") or Path.home() / ".cache/sagae-kb/build") / "contract-hypothesis")) / "hypothesis"))

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cfx_run as R   # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_config(kb_home, monkeypatch):
    cfg = kb_home / "config"
    cfg.mkdir(exist_ok=True)
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    return cfg


@pytest.fixture(scope="session")
def requests_doc():
    return R.load_requests()


@pytest.fixture
def stored():
    """디스크의 응답 파일을 id로 읽는다."""
    import json

    def get(cid):
        return json.loads((R.FIX / "responses" / f"{cid}.json").read_text(encoding="utf-8"))
    return get


@pytest.fixture(scope="session")
def session_home():
    """세션 하나 동안 쓰는 임시 KB_HOME(디스크. /tmp는 tmpfs라 쓰지 않는다). fixture를 재생한 세계가 들어 있다."""
    import os
    import shutil
    import uuid

    prod = Path("/home/user/sagae-kb-data").resolve()
    env = os.environ.get("KB_HOME")
    root = Path(env).resolve() if env else None
    if root is None or root == prod or prod in root.parents:
        root = Path(os.environ.get("KB_BUILD_ROOT") or Path.home() / ".cache/sagae-kb/build") / "pytest-default"
    d = root / "test-tmp" / "contract" / uuid.uuid4().hex[:12]
    (d / "config").mkdir(parents=True)
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("KB_HOME", str(d))
        mp.setenv("KB_CONFIG_DIR", str(d / "config"))
        mp.delenv("KB_SHARE", raising=False)
        mp.delenv("KB_MCP_SESSION", raising=False)
        yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture(scope="session")
def replayed_session(session_home, requests_doc):
    """디스크 fixture를 재생한 세계(세션 공용, 읽기 전용으로만 쓴다)."""
    from test_fixture_roundtrip import _load_world
    rp = _load_world(session_home, requests_doc)
    yield rp
    rp.close()
