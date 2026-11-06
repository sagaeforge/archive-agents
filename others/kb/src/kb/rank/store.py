"""벡터 색인 파일(derived/vec/<build>/). vectors.npy(int8, N x DIM), ids.txt(공개 ID), kinds.txt(종류 글자), shas.txt, meta.json.

numpy가 있으면(venv-rank) 전수 코사인을 numpy로, 없으면 순수 파이썬으로 센다(시험과 작은 색인용).
.npy는 표준 형식 v1.0이라 numpy가 그대로 읽는다. 벡터는 파생물이다. 지워도 kb index로 다시 만든다.
"""
from __future__ import annotations

import ast
import json
import os
import struct
from pathlib import Path

from kb.rank import conf

try:  # venv-rank에만 있다
    import numpy as np
except ImportError:  # pragma: no cover - 환경 의존
    np = None

_MAGIC = b"\x93NUMPY"


def write_npy(path: Path, rows: list[bytes], dim: int) -> None:
    hdr = "{'descr': '|i1', 'fortran_order': False, 'shape': (%d, %d), }" % (len(rows), dim)
    pad = (64 - (10 + len(hdr) + 1) % 64) % 64
    hdr = (hdr + " " * pad + "\n").encode("latin1")
    with open(path, "wb") as f:
        f.write(_MAGIC + b"\x01\x00" + struct.pack("<H", len(hdr)) + hdr)
        for r in rows:
            if len(r) != dim:
                raise ValueError("행 길이 불일치")
            f.write(r)
        f.flush()
        os.fsync(f.fileno())


def read_npy(path: Path):
    """(N, dim, 데이터 오프셋). 형식 v1.0 int8 C 순서만 받는다."""
    with open(path, "rb") as f:
        if f.read(6) != _MAGIC:
            raise ValueError("npy 아님")
        major, _minor = f.read(2)
        if major != 1:
            raise ValueError("npy 판 미지원")
        (n,) = struct.unpack("<H", f.read(2))
        h = ast.literal_eval(f.read(n).decode("latin1"))
        off = f.tell()
    if h["descr"] != "|i1" or h["fortran_order"]:
        raise ValueError("int8 C 순서만 지원")
    r, d = h["shape"]
    return r, d, off


def quantize(vec) -> bytes:
    """L2 정규화된 실수 벡터 -> int8 바이트(부호 있음)."""
    return bytes((max(-127, min(127, round(x * 127))) & 0xFF) for x in vec)


class Index:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.meta = json.loads((self.root / "meta.json").read_text(encoding="utf-8"))
        rd = lambda n: (self.root / n).read_text(encoding="utf-8").split("\n")[:-1] if (self.root / n).stat().st_size else []  # noqa: E731
        self.ids, self.kinds, self.shas = rd("ids.txt"), rd("kinds.txt"), rd("shas.txt")
        n, d, off = read_npy(self.root / "vectors.npy")
        if not (n == len(self.ids) == len(self.kinds) == len(self.shas)):
            raise ValueError("색인 파일 행 수 불일치")
        self.n, self.dim, self._off = n, d, off
        self._mat = None
        self._raw = None
        self._by_kind: dict[str, object] = {}

    @property
    def build(self) -> str:
        return self.meta.get("build", self.root.name)

    def _matrix(self):
        if self._mat is None:
            if np is not None and self.n:
                self._mat = np.memmap(self.root / "vectors.npy", dtype=np.int8, mode="r", offset=self._off, shape=(self.n, self.dim))
            else:
                self._raw = (self.root / "vectors.npy").read_bytes()[self._off:]
                self._mat = True
        return self._mat

    def row(self, i: int) -> bytes:
        m = self._matrix()
        if np is not None and not isinstance(m, bool):
            return bytes(m[i].tobytes())
        return self._raw[i * self.dim:(i + 1) * self.dim]

    def _rows_of(self, letters: str):
        if letters not in self._by_kind:
            idx = [i for i, k in enumerate(self.kinds) if k in letters]
            self._by_kind[letters] = np.asarray(idx, dtype=np.int64) if np is not None else idx
        return self._by_kind[letters]

    def topk(self, q: bytes, k: int, letters: str = "crep") -> list[str]:
        """전수 코사인(정규화된 int8 내적) 상위 k개의 공개 ID. 동점은 색인 순서."""
        if len(q) != self.dim:
            raise ValueError("질의 벡터 차원 불일치")
        m = self._matrix()
        idx = self._rows_of(letters)
        if not len(idx) or k <= 0:
            return []
        if np is not None and not isinstance(m, bool):
            qf = np.frombuffer(q, dtype=np.int8).astype(np.float32)
            sc = np.empty(len(idx), dtype=np.float32)
            for s in range(0, len(idx), 20000):
                sc[s:s + 20000] = m[idx[s:s + 20000]].astype(np.float32) @ qf
            top = np.argsort(-sc, kind="stable")[:k]
            return [self.ids[int(idx[j])] for j in top]
        qi = [b - 256 if b > 127 else b for b in q]
        scored = []
        for pos, i in enumerate(idx):
            r = self._raw[i * self.dim:(i + 1) * self.dim]
            scored.append((-sum(a * (b - 256 if b > 127 else b) for a, b in zip(qi, r)), pos, i))
        scored.sort()
        return [self.ids[i] for _, _, i in scored[:k]]


def write_index(root: Path, build: str, ids: list[str], kinds: list[str], shas: list[str], rows: list[bytes], extra: dict) -> None:
    root.mkdir(parents=True, exist_ok=False)
    write_npy(root / "vectors.npy", rows, conf.DIM)
    for name, vals in (("ids.txt", ids), ("kinds.txt", kinds), ("shas.txt", shas)):
        (root / name).write_text("".join(v + "\n" for v in vals), encoding="utf-8")
    meta = {"build": build, "dim": conf.DIM, "rows": len(ids), "dtype": "int8", **extra}
    (root / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def current_root() -> Path | None:
    p = conf.vec_root() / "current"
    return p.resolve() if p.is_symlink() and (p / "meta.json").exists() else None


def point_current(build: str) -> None:
    root = conf.vec_root()
    nxt = root / "current.next"
    if nxt.is_symlink() or nxt.exists():
        nxt.unlink()
    os.symlink(build, nxt)
    os.replace(nxt, root / "current")
