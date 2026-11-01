"""질의 별칭 확장(WP-05). alias 표(schemas/aliases/*.toml)와 gold의 entity alias 표를 쓴다.

질의를 단어로 나눠 앞에서부터 가장 긴 창(3, 2, 1단어)이 별칭 표에 있으면 그 자리를 대안 목록으로 바꾼다.
한 단어는 별칭 형식으로 시작하면(접두 일치) 나머지를 붙여 대안을 만든다(`8천시간` -> `8000시간`).
표준 라이브러리만 쓴다.
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from kb.core import paths
from kb.core.text import nfc

LOAD_ERRORS: list[str] = []
MAX_WINDOW = 3


def norm(s: str) -> str:
    return " ".join(nfc(s).lower().split())


def key(s: str) -> str:
    return norm(s).replace(" ", "")


@dataclass
class Segment:
    text: str                       # 질의의 원문 조각
    alts: list[str] = field(default_factory=list)   # 별칭으로 만든 대안(원문 제외)


def aliases_dir() -> Path:
    return paths.share_dir() / "schemas" / "aliases"


@lru_cache(maxsize=8)
def _load(stamp: tuple) -> dict[str, tuple[str, ...]]:
    table: dict[str, list[str]] = {}

    def add(term: str, alts) -> None:
        k = key(term)
        if not k:
            return
        cur = table.setdefault(k, [])
        for a in alts:
            a = norm(a)
            if a and key(a) != k and a not in cur:
                cur.append(a)

    for name, _ in stamp:
        try:
            with open(name, "rb") as f:
                d = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError) as e:
            LOAD_ERRORS.append(f"{name}: {e}")
            continue
        for g in d.get("group", []):
            forms = [x for x in g.get("forms", []) if isinstance(x, str)]
            for f_ in forms:
                add(f_, [x for x in forms if x != f_])
        for a in d.get("alias", []):
            if isinstance(a.get("term"), str):
                add(a["term"], [x for x in a.get("expand", []) if isinstance(x, str)])
    return {k: tuple(v) for k, v in table.items()}


def table(directory: Path | None = None) -> dict[str, tuple[str, ...]]:
    d = directory or aliases_dir()
    try:
        files = sorted(d.glob("*.toml"))
        stamp = tuple((str(p), p.stat().st_mtime_ns) for p in files)
    except OSError:
        stamp = ()
    return _load(stamp)


def _ascii_alnum(c: str) -> bool:
    return c.isascii() and c.isalnum()


def _prefix_alts(word: str, tbl: dict) -> list[str]:
    """word가 별칭 형식 f로 시작하면 (f의 대안 + 나머지). 가장 긴 f 하나만 쓴다."""
    best = None
    for f_ in tbl:
        if len(f_) < len(word) and word.startswith(f_) and (best is None or len(f_) > len(best)):
            if _ascii_alnum(f_[-1]) and _ascii_alnum(word[len(f_)]):
                continue  # 라틴 단어의 중간에서 끊지 않는다
            best = f_
    if best is None:
        return []
    rest = word[len(best):]
    return [a + rest for a in tbl[best]]


def expand(words: list[str], extra: dict[str, tuple[str, ...]] | None = None) -> list[Segment]:
    """words(NFC, 소문자)를 조각으로 묶고 각 조각의 별칭 대안을 붙인다."""
    tbl = dict(table())
    for k, v in (extra or {}).items():
        tbl[k] = tuple(dict.fromkeys((*tbl.get(k, ()), *v)))
    out: list[Segment] = []
    i = 0
    while i < len(words):
        hit = None
        for n in range(min(MAX_WINDOW, len(words) - i), 0, -1):
            win = words[i:i + n]
            k = key(" ".join(win))
            if k in tbl:
                hit = (n, Segment(" ".join(win), list(tbl[k])))
                break
        if hit is None:
            w = words[i]
            hit = (1, Segment(w, _prefix_alts(key(w), tbl)))
        out.append(hit[1])
        i += hit[0]
    return out


def entity_forms(con, words: list[str]) -> dict[str, tuple[str, ...]]:
    """gold alias 표에서 질의 단어(또는 인접 2~3단어)와 같은 norm의 노드 라벨과 다른 별칭."""
    cands: dict[str, str] = {}   # gold norm 후보 -> 표 키
    for n in range(1, min(MAX_WINDOW, len(words)) + 1):
        for i in range(len(words) - n + 1):
            w = " ".join(words[i:i + n])
            cands[w] = key(w)
            cands[w.replace(" ", "")] = key(w)
    out: dict[str, tuple[str, ...]] = {}
    if not cands:
        return out
    ph = ",".join("?" * len(cands))
    try:
        rr = con.execute(f"SELECT norm, node_id FROM alias WHERE norm IN ({ph})", list(cands)).fetchall()
    except Exception:  # alias 표가 없는 gold
        return out
    for norm_, nid in rr:
        alts = [r[0] for r in con.execute("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (nid,))]
        alts += [r[0] for r in con.execute("SELECT norm FROM alias WHERE node_id=?", (nid,))]
        k = cands[norm_]
        alts = [a for a in dict.fromkeys(alts) if key(a) != k]
        if alts:
            out[k] = tuple(dict.fromkeys((*out.get(k, ()), *(norm(a) for a in alts))))
    return out
