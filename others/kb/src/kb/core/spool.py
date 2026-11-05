"""원장에 들어가기 전의 대기 경로. 임시 파일 -> fsync -> rename -> 디렉터리 fsync."""
from __future__ import annotations

import itertools
import json
import os
from pathlib import Path
from typing import Any, Iterator

from kb.core import cas, paths
from kb.core.canon import canon_json, sha256_hex

KINDS = {"in": "in", "fp-held": "fp-held", "l2": "l2"}


class SpoolConflict(Exception):
    """같은 이름에 내용이 다른 항목. 스풀은 응답 뒤의 T0 데이터라 덮어쓰지 않는다."""


def dir_of(kind: str) -> Path:
    if kind not in KINDS:
        raise ValueError(f"스풀 종류 오류: {kind!r}")
    return paths.spool_dir() / KINDS[kind]


def put(kind: str, obj: Any, name: str | None = None) -> Path:
    """JSON 한 건을 남긴다. name이 없으면 정규 JSON의 sha256.
    같은 이름에 같은 내용이면 같은 파일(멱등), 다른 내용이면 SpoolConflict."""
    d = dir_of(kind)
    body = canon_json(obj)
    stem = name or sha256_hex(body)
    if "/" in stem or stem.startswith("."):
        raise ValueError(f"스풀 이름 오류: {stem!r}")
    cas.make_dirs(d)
    final = d / f"{stem}.json"
    tmp = cas.write_temp(d, body)
    try:
        if name is None:  # 이름이 내용의 해시다. 깨진 사본이 있어도 덮어써서 복구된다
            os.rename(tmp, final)
        else:
            try:
                os.link(tmp, final)  # rename과 달리 이미 있으면 실패한다
            except FileExistsError:
                if final.read_bytes() != body:
                    raise SpoolConflict(f"스풀 이름 충돌: {final.name}") from None
            os.unlink(tmp)
    except BaseException:
        cas.unlink_quiet(tmp)
        raise
    cas.fsync_dir(d)
    return final


def iter_items(kind: str) -> Iterator[tuple[Path, Any]]:
    """항목을 차례로 낸다. 해석되지 않는 파일은 지우지 않고 .failed/로 옮기고 다음으로 넘어간다."""
    d = dir_of(kind)
    if not d.exists():
        return
    for p in sorted(d.glob("*.json")):
        try:
            raw = p.read_bytes()
        except FileNotFoundError:  # 다른 프로세스가 처리했다
            continue
        try:
            obj = json.loads(raw)
        except (ValueError, RecursionError):  # 깊이가 큰 JSON은 RecursionError다
            try:
                mark_failed(p)
            except FileNotFoundError:  # 다른 프로세스가 먼저 옮기거나 처리했다
                pass
            continue
        yield p, obj


def remove(path: Path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return
    cas.fsync_dir(path.parent)


def mark_failed(path: Path) -> Path:
    """Editor transitions share the quota lock with retrieval and purge."""
    from kb.write import fpquota
    editor = (fpquota.refs_dir() / path.name).exists()
    if not editor:
        try:
            first = json.loads(path.read_bytes())["events"][0]
            editor = first.get("origin") == "first_party" and first.get("actor", "").startswith("app:")
        except (ValueError, TypeError, KeyError, IndexError):
            editor = False
    if editor:
        from kb.write.write_refs import failed_copy
        with fpquota.lock():
            dst = _mark_failed(path)
            failed_copy(path, locked=True)
            return dst
    return _mark_failed(path)


def _mark_failed(path: Path) -> Path:
    """재적재가 거부된 파일을 지우지 않고 .failed/로 옮긴다. 같은 이름의 앞선 기록을 덮어쓰지 않는다."""
    f = path.parent / ".failed"
    cas.make_dirs(f)
    body = path.read_bytes()
    for i in itertools.count():
        dst = f / (path.name if i == 0 else f"{path.stem}.{i}{path.suffix}")
        try:
            os.link(path, dst)
            break
        except FileExistsError:
            if dst.read_bytes() == body:
                break
    cas.fsync_dir(f)  # 옮긴 사본이 디스크에 닿은 뒤에야 원본을 지운다
    os.unlink(path)
    cas.fsync_dir(path.parent)
    return dst
