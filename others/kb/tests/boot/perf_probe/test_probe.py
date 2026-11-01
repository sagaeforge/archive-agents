import pytest


@pytest.mark.perf
def test_slow():
    raise AssertionError("perf 마커는 기본 제외")
