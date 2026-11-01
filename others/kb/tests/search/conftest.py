import pytest

from .shelp import World


@pytest.fixture
def w(kb_home):
    world = World(kb_home)
    yield world
    world.close()
