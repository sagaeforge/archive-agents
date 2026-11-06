"""HTTP 시험 공용 픽스처. 합성 데이터만 쓰고 실운영 경로와 전역 파일을 건드리지 않는다."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from httphelp import Client, World, seed   # noqa: E402

from kb.serve.http import ServeConfig, build_app   # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_config(kb_home, monkeypatch):
    """설정, 토큰 파일을 시험 폴더로 돌린다(~/.config/sagae-kb를 읽거나 쓰지 않는다)."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    return cfg


@pytest.fixture
def cfgdir(_isolated_config):
    return _isolated_config


@pytest.fixture
def world(kb_home):
    w = World(kb_home)
    seed(w)
    yield w
    w.close()


@pytest.fixture
def cfg(world):
    return ServeConfig(db_path=str(world.path))


@pytest.fixture
def app(cfg):
    return build_app(cfg)


@pytest.fixture
def client(app):
    return Client(app)


@pytest.fixture
def tcp_client(app):
    return Client(app, tcp=True)
