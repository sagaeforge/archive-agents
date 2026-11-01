"""술어 어휘: schemas/predicates.yaml + schemas/predicates.d/*.yaml. 미등록 술어는 null로 저장하고 후보 큐에 넣는다."""
from __future__ import annotations

from functools import lru_cache

from kb.core import opsdb, paths


@lru_cache(maxsize=4)
def _load(root: str) -> frozenset:
    from pathlib import Path
    import yaml
    r = Path(root) / "schemas"
    files = [r / "predicates.yaml", *sorted((r / "predicates.d").glob("*.yaml"))]
    out: set = set()
    for f in files:
        if f.is_file():
            for p in (yaml.safe_load(f.read_text(encoding="utf-8")) or {}).get("predicates", []):
                out.add(p["id"])
    return frozenset(out)


def predicates() -> frozenset:
    return _load(str(paths.share_dir()))


def predicate_known(p: str) -> bool:
    return p in predicates()


def candidate(value: str, kind: str = "predicate") -> None:
    """어휘 후보 큐. 같은 값은 seen만 올린다."""
    c = opsdb.connect()
    try:
        now = int(__import__("time").time() * 1000)
        c.execute("INSERT INTO candidate(kind, value, first_seen, seen) VALUES(?,?,?,1) "
                  "ON CONFLICT(kind, value) DO UPDATE SET seen=seen+1", (kind, value, now))
    finally:
        c.close()
