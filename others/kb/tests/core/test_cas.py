import errno
import os
import random
import subprocess
import sys
import textwrap

import pytest

from kb.core import cas, paths, spool


def test_roundtrip_and_layout(kb_home):
    data = "본문".encode() * 1000
    sha = cas.put(data)
    assert cas.exists(sha) and cas.get(sha) == data and cas.verify(sha)
    assert cas.put(data) == sha
    p = paths.raw_dir() / "objects" / sha[:2] / sha
    assert p.is_file() and p.stat().st_size < len(data)
    assert not [f for f in p.parent.iterdir() if f.name.startswith(".tmp")]
    assert cas.put(b"x", "fp") != cas.put(b"y", "fp")
    assert not cas.exists(sha, "fp")
    with pytest.raises(ValueError):
        cas.put(b"x", "bogus")
    with pytest.raises(cas.CasMissing):
        cas.get("0" * 64)


def test_truncation_and_flip_always_detected(kb_home):
    rng = random.Random(7)
    for i in range(100):
        data = os.urandom(rng.randint(1, 3000)) if i % 2 else (b"abc" * rng.randint(1, 800))
        sha = cas.put(data, "ttl")
        p = cas.path_of(sha, "ttl")
        good = p.read_bytes()
        if i % 3 == 0:
            bad = good[: rng.randint(0, len(good) - 1)]
        else:
            k = rng.randrange(len(good))
            bad = good[:k] + bytes([good[k] ^ (1 << rng.randrange(8))]) + good[k + 1:]
        p.write_bytes(bad)
        assert not cas.verify(sha, "ttl"), i
        with pytest.raises(cas.CasCorrupt):
            cas.get(sha, "ttl")
        assert cas.put(data, "ttl") == sha and cas.verify(sha, "ttl")  # 손상 객체는 다시 쓰면 복구된다


def test_rejects_tmpfs(monkeypatch):
    monkeypatch.setenv("KB_HOME", "/tmp/kb-cas-test")
    with pytest.raises(paths.FsRejected):
        cas.put(b"x")


def _short_writes(monkeypatch, limit=7):
    real = os.write
    monkeypatch.setattr(os, "write", lambda fd, b: real(fd, bytes(b)[:limit]))


def test_short_write_completed(kb_home, monkeypatch):
    data = os.urandom(5000)
    _short_writes(monkeypatch, 13)
    sha = cas.put(data)
    p = spool.put("in", {"x": "y" * 500})
    monkeypatch.undo()
    monkeypatch.setenv("KB_HOME", str(kb_home))
    assert cas.get(sha) == data
    assert [x for _, x in spool.iter_items("in")] == [{"x": "y" * 500}] and p.exists()


def test_write_failure_midway_leaves_nothing(kb_home, monkeypatch):
    real = os.write
    calls = []

    def fail(fd, b):
        calls.append(1)
        if len(calls) > 1:
            raise OSError(errno.ENOSPC, "디스크 가득")
        return real(fd, bytes(b)[:10])

    monkeypatch.setattr(os, "write", fail)
    data = os.urandom(5000)
    with pytest.raises(OSError):
        cas.put(data)
    calls.clear()
    with pytest.raises(OSError):
        spool.put("in", {"x": "y" * 500})
    monkeypatch.undo()
    monkeypatch.setenv("KB_HOME", str(kb_home))
    for tree in (paths.raw_dir(), paths.spool_dir()):
        assert [f for f in tree.rglob("*") if f.is_file()] == []


def test_write_returning_zero_is_an_error(kb_home, monkeypatch):
    monkeypatch.setattr(os, "write", lambda fd, b: 0)
    with pytest.raises(OSError):
        cas.put(b"x" * 100)


def test_real_file_size_limit_is_refused(kb_home):
    """RLIMIT_FSIZE는 ENOSPC 직전의 짧은 쓰기를 실제로 만든다."""
    code = textwrap.dedent("""
        import os, resource, signal
        from kb.core import cas, spool
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (4096, 4096))
        for f in (lambda: cas.put(os.urandom(50000)), lambda: spool.put("in", {"x": "y" * 50000})):
            try:
                f()
            except OSError as e:
                print("refused", e.errno)
            else:
                print("ACCEPTED")
    """)
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=os.environ.copy())
    assert r.returncode == 0, r.stderr
    assert r.stdout.split("\n")[:2] == [f"refused {errno.EFBIG}"] * 2
    assert list(spool.iter_items("in")) == []


def test_new_parent_dirs_are_fsynced(kb_home, monkeypatch):
    seen = []
    real = cas.fsync_dir
    monkeypatch.setattr(cas, "fsync_dir", lambda d: (seen.append(str(d)), real(d))[1])
    sha = cas.put(b"x")
    raw = paths.raw_dir()
    assert {str(kb_home), str(raw), str(raw / "objects"), str(raw / "objects" / sha[:2])} <= set(seen)
    seen.clear()
    spool.put("in", {"a": "b"})
    assert {str(kb_home), str(paths.spool_dir()), str(paths.spool_dir() / "in")} <= set(seen)


def test_put_fast_path_fsyncs_dir(kb_home, monkeypatch):
    sha = cas.put(b"hello")
    calls = []
    monkeypatch.setattr(cas, "fsync_dir", lambda d: calls.append(d))
    assert cas.put(b"hello") == sha
    assert calls == [cas.path_of(sha, "objects").parent]
