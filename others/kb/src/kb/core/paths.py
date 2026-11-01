"""경로와 파일시스템 검사."""
from __future__ import annotations

import os
from pathlib import Path

DEFAULT_KB_HOME = "/home/user/sagae-kb-data"
REJECTED_FS = frozenset({"tmpfs", "9p", "drvfs"})
MIN_FREE_BYTES = 1 << 30


class FsRejected(Exception):
    code = "fs_rejected"


def kb_home() -> Path:
    return Path(os.environ.get("KB_HOME") or DEFAULT_KB_HOME)


def share_dir() -> Path:
    s = os.environ.get("KB_SHARE")
    if s:
        return Path(s)
    return Path(__file__).resolve().parents[3]


def config_dir() -> Path:
    c = os.environ.get("KB_CONFIG_DIR")
    return Path(c) if c else Path.home() / ".config" / "sagae-kb"


def toolchain_dir() -> Path:
    return Path(os.environ.get("KB_TOOLCHAIN") or kb_home() / "runtime")


def test_tmp_dir() -> Path:
    return kb_home() / "test-tmp"


def ledger_dir() -> Path:
    return kb_home() / "ledger"


def raw_dir() -> Path:
    return kb_home() / "raw"


def spool_dir() -> Path:
    return kb_home() / "spool"


def inbox_dir() -> Path:
    return kb_home() / "inbox"


def ops_dir() -> Path:
    return kb_home() / "ops"


def runtime_dir() -> Path:
    return kb_home() / "runtime"


def _unescape(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 3 < len(s) + 0 and s[i + 1 : i + 4].isdigit():
            out.append(chr(int(s[i + 1 : i + 4], 8)))
            i += 4
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def fstype_of(path: str | os.PathLike, mountinfo: str = "/proc/self/mountinfo") -> str | None:
    """path가 속한 마운트의 파일시스템 종류. 가장 긴 마운트 지점을 고른다."""
    p = os.path.realpath(os.fspath(path))
    best, best_t = "", None
    with open(mountinfo, encoding="utf-8", errors="replace") as f:
        for line in f:
            left, sep, right = line.partition(" - ")
            if not sep:
                continue
            fields = left.split()
            if len(fields) < 5:
                continue
            mp = _unescape(fields[4])
            fst = right.split()[0] if right.split() else ""
            if p == mp or p.startswith(mp.rstrip("/") + "/") or mp == "/":
                if len(mp) >= len(best):
                    best, best_t = mp, fst
    return best_t


def check_fs(path: str | os.PathLike, mountinfo: str = "/proc/self/mountinfo") -> str:
    """tmpfs, 9p, drvfs 위의 경로를 거부한다. 우회 환경 변수는 없다. 종류를 돌려준다."""
    t = fstype_of(path, mountinfo)  # realpath는 없는 경로도 존재하는 부분까지 풀어 준다
    if t is None:
        raise FsRejected(f"파일시스템 종류를 알 수 없음: {path}")
    if t in REJECTED_FS:
        raise FsRejected(f"{t} 위의 경로는 거부: {path}")
    return t
