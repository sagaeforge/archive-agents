"""게이트 시험 공용: 실제 주장 49건과 표시 본문 4개, 주어 별칭·등록 엔티티 별칭 구성.
별칭은 시험 쪽에서 만든다(운영에서는 엔티티 라벨과 별칭 표). 프로토타입 gate2_fix.py의 ALIAS와 같은 규칙이다."""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

from kb.gate import GateCtx, check_claim
from kb.parse.paragraphs import paragraphs

FX = Path(__file__).resolve().parents[1] / "fixtures" / "gate"
DATA = Path(__file__).resolve().parent / "data"
sys.path.insert(0, str(FX))
from t5_tables import SUBJ  # noqa: E402

PUBLISHER = {"ypp_ko": "YouTube 고객센터", "headless": "Anthropic", "kowiki_yt": "위키백과", "quota": "Google"}
ALIAS = {"ypp": ["youtube 파트너 프로그램", "파트너 프로그램", "ypp"], "--bare": ["--bare", "bare"],
         "youtube": ["youtube", "유튜브"], "유튜브": ["youtube", "유튜브"], "구글": ["google", "구글"]}
KNOWN = sorted({x for a, b in SUBJ for x in (a, b)} | {"youtube", "유튜브", "google", "구글"}, key=len, reverse=True)


def rows() -> list:
    return json.loads((FX / "gate_rows.json").read_text(encoding="utf-8"))


def docs() -> dict:
    return {n: unicodedata.normalize("NFC", (FX / "docs" / f"{n}.txt").read_text(encoding="utf-8"))
            for n in ("headless", "kowiki_yt", "quota", "ypp_ko")}


_PARAS: dict = {}


def paras_of(page: str, text: str) -> list:
    if page not in _PARAS:
        _PARAS[page] = paragraphs(text, "markdown")
    return _PARAS[page]


def subject_aliases(subject: str) -> list:
    out = [subject]
    out += re.findall(r"\(([^)]+)\)", subject)
    toks = [t for t in re.split(r"[\s/()·,]+", subject) if len(t) >= 2]
    out += toks
    for t in toks:
        out += ALIAS.get(t.lower(), [])
    return list(dict.fromkeys(out))


def known_aliases() -> dict:
    return {k.lower(): f"e:test:k{i}" for i, k in enumerate(KNOWN)}


def title_of(text: str) -> str:
    for ln in text.split("\n")[:60]:
        if ln.strip():
            return ln.strip()[:200]
    return ""


def ctx_for(row: dict, text: str, **kw) -> GateCtx:
    return GateCtx(subject="e:test:subject", subject_aliases=tuple(subject_aliases(row.get("subject") or "")),
                   known_aliases=known_aliases(), doc_title=title_of(text), publisher=PUBLISHER.get(row.get("page")), **kw)


def run(row: dict, statement: str | None = None, quote: str | None = None):
    d = docs()
    text = d[row["page"]]
    claim = {"statement": statement if statement is not None else row["statement"],
             "quote": quote if quote is not None else row["quote"], "kind": "state", "stance": "stated"}
    return check_claim(claim, text, paras_of(row["page"], text), ctx_for(row, text))
