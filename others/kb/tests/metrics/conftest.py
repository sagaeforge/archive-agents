import json
import time

import pytest

from kb.core import opsdb

NOW = int(time.time() * 1000)


@pytest.fixture
def ops(kb_home):
    c = opsdb.connect()
    yield c
    c.close()


def call(c, at, backend="openrouter", model="sol", cost=0.01, **dims):
    d = {"backend": backend, "model": model, "error": False, "elapsed_s": 2.0, "reason": "primary", "finish": "stop"}
    d.update(dims)
    opsdb.record_metric(c, "llm.call", cost, d, at=at)
