import itertools

import pytest

from kb.core import ledger

_n = itertools.count()


@pytest.fixture
def led(kb_home):
    c = ledger.open_ledger()
    yield c
    c.close()


def ev(kind="record.put", payload=None, subject=None, idem=None, actor="user:sagae", origin="first_party", **kw):
    n = next(_n)
    return {"kind": kind, "actor": actor, "origin": origin, "subject": subject or f"f-t{n}",
            "idem_key": idem or f"k{n}", "payload": payload or {"n": n}, **kw}


@pytest.fixture
def mk():
    return ev
