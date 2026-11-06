import pytest

from kb.core import ledger
from projhelp import new_gold


@pytest.fixture
def led(kb_home):
    c = ledger.open_ledger()
    yield c
    c.close()


@pytest.fixture
def gold(kb_home):
    g = new_gold(kb_home, "g")
    yield g
    g.close()
