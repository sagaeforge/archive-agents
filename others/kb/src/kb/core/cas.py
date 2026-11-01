"""내용 주소 저장소. 파일 = zstd 프레임 + sha256(프레임) 꼬리표. 이름 = sha256(무압축 바이트)."""
from __future__ import annotations

import errno
import hashlib
import os
import uuid
from pathlib import Path

from compression import zstd

from kb.core import paths

TIERS = ("objects", "fp", "ttl")
TRAILER = 32
LEVEL = 3
_MAX_WRITE = 1 << 30  # 커널 상한(0x7ffff000)보다 작게 나눈다


class CasError(Exception):
    pass


class CasCorrupt(CasError):
    pass


class CasMissing(CasError, FileNotFoundError):
    pass


def _tier(tier: str) -> str:
    if tier not in TIERS:
        raise ValueError(f"tier 오류: {tier!r}")
    return tier


def path_of(sha: str, tier: str = "objects") -> Path:
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise ValueError(f"sha 형식 오류: {sha!r}")
    return paths.raw_dir() / _tier(tier) / sha[:2] / sha


def fsync_dir(d: Path) -> None:
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def make_dirs(d: Path) -> None:
    """d를 만들고, 새로 생긴 항목마다 그 부모 디렉터리를 fsync 한다."""
    missing = []
    cur = Path(d)
    while not cur.exists():
        missing.append(cur)
        cur = cur.parent
    Path(d).mkdir(parents=True, exist_ok=True)
    for m in missing:
        fsync_dir(m.parent)


def write_all(fd: int, data: bytes) -> None:
    """os.write는 일부만 쓰고도 성공한다(ENOSPC 직전, 파일 크기 제한, 2 GiB 초과). 끝까지 쓰거나 예외를 낸다."""
    view = memoryview(data)
    while len(view):
        n = os.write(fd, view[:_MAX_WRITE])
        if n <= 0:
            raise OSError(errno.EIO, "os.write가 진행하지 못함")
        view = view[n:]


def unlink_quiet(p: Path) -> None:
    try:
        os.unlink(p)
    except FileNotFoundError:
        pass


def write_temp(d: Path, data: bytes) -> Path:
    """d 안의 임시 파일에 전부 쓰고 fsync 한다. 실패하면 임시 파일을 남기지 않는다."""
    tmp = d / f".tmp-{uuid.uuid4().hex}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        try:
            write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
    except BaseException:
        unlink_quiet(tmp)
        raise
    return tmp


def atomic_write(p: Path, data: bytes) -> None:
    """임시 파일 -> fsync -> rename -> 디렉터리 fsync. 새로 만든 상위 디렉터리도 fsync 한다."""
    make_dirs(p.parent)
    tmp = write_temp(p.parent, data)
    try:
        os.rename(tmp, p)
    except BaseException:
        unlink_quiet(tmp)
        raise
    fsync_dir(p.parent)


def _encode(data: bytes) -> bytes:
    frame = zstd.compress(data, options={zstd.CompressionParameter.compression_level: LEVEL,
                                         zstd.CompressionParameter.checksum_flag: 1})
    return frame + hashlib.sha256(frame).digest()


def _decode(blob: bytes, sha: str) -> bytes:
    if len(blob) <= TRAILER:
        raise CasCorrupt(f"객체가 잘림: {sha}")
    frame, tail = blob[:-TRAILER], blob[-TRAILER:]
    if hashlib.sha256(frame).digest() != tail:
        raise CasCorrupt(f"꼬리표 불일치: {sha}")
    try:
        data = zstd.decompress(frame)
    except Exception as e:  # zstd.ZstdError 포함
        raise CasCorrupt(f"압축 해제 실패: {sha}: {e}") from e
    if hashlib.sha256(data).hexdigest() != sha:
        raise CasCorrupt(f"해시 불일치: {sha}")
    return data


def _read(sha: str, tier: str) -> bytes:
    p = path_of(sha, tier)
    try:
        return p.read_bytes()
    except FileNotFoundError as e:
        raise CasMissing(f"객체 없음: {sha}") from e


def put(data: bytes, tier: str = "objects") -> str:
    """임시 파일 -> fsync -> rename -> 디렉터리 fsync. 이미 온전한 객체가 있으면 다시 쓰지 않는다."""
    sha = hashlib.sha256(data).hexdigest()
    p = path_of(sha, tier)
    if p.exists() and verify(sha, tier):
        fsync_dir(p.parent)
        return sha
    paths.check_fs(paths.raw_dir())
    atomic_write(p, _encode(data))
    return sha


def get(sha: str, tier: str = "objects") -> bytes:
    return _decode(_read(sha, tier), sha)


def exists(sha: str, tier: str = "objects") -> bool:
    return path_of(sha, tier).is_file()


def verify(sha: str, tier: str = "objects") -> bool:
    try:
        _decode(_read(sha, tier), sha)
        return True
    except (CasError, OSError):
        return False


def delete(sha: str, tier: str = "objects") -> bool:
    """record.redact 전용. 지웠으면 True."""
    p = path_of(sha, tier)
    try:
        os.unlink(p)
    except FileNotFoundError:
        return False
    fsync_dir(p.parent)
    return True


def iter_shas(tier: str = "objects"):
    root = paths.raw_dir() / _tier(tier)
    if not root.exists():
        return
    for sub in sorted(root.iterdir()):
        if sub.is_dir():
            for f in sorted(sub.iterdir()):
                if len(f.name) == 64 and not f.name.startswith("."):
                    yield f.name
