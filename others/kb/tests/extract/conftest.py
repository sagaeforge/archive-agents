import pytest

from . import helpers as H


@pytest.fixture
def env(kb_home, monkeypatch):
    return H.seed_env(kb_home, monkeypatch)


@pytest.fixture
def envk(kb_home, monkeypatch):
    return H.seed_env(kb_home, monkeypatch, with_key=True)


@pytest.fixture
def ent(env):
    H.put_entity("e:tool:sample", "샘플도구", aliases=["샘플도구", "sampletool"])
    return "e:tool:sample"
