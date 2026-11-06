"""3단계: 인용구 위치 찾기. NFC와 공백 접기만 허용하고 결과는 표시 본문의 코드포인트 오프셋이다."""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache

MIN_QUOTE = 8
MAX_HITS = 64
MAX_WINDOW_HITS = 1024       # 창이 있을 때의 적중 상한. 넘으면 창 안 좁히기를 하지 않고 E_QUOTE_AMBIGUOUS(실패 닫힘)


class QuoteError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


@dataclass(frozen=True)
class Loc:
    start: int
    end: int


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def fold(s: str) -> str:
    """NFC + 공백 압축 + 앞뒤 공백 제거."""
    return " ".join(nfc(s).split())


@lru_cache(maxsize=8)
def _folded(text: str) -> tuple[str, tuple]:
    """접힌 본문과 접힌 위치 -> 원문 위치 표."""
    out, idx, prev_sp = [], [], False
    for i, ch in enumerate(text):
        if ch.isspace():
            if not prev_sp:
                out.append(" ")
                idx.append(i)
                prev_sp = True
        else:
            out.append(ch)
            idx.append(i)
            prev_sp = False
    return "".join(out), tuple(idx)


def window_spans(text: str, spans) -> tuple:
    """창이 모델에 보여 준 원문 구간 [(시작, 끝)]. 사이가 공백뿐인 인접 구간은 합친다(창 본문은 문단을 빈 줄로 잇는다).
    그 밖의 틈(건너뛴 문단)은 모델이 보지 못한 곳이므로 합치지 않는다."""
    out: list = []
    for a, b in sorted((int(a), int(b)) for a, b in spans or ()):
        if out and a <= out[-1][1] or (out and not text[out[-1][1]:a].strip()):
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return tuple(out)


def locate(text: str, quote: str, prefix: str = "", suffix: str = "", window=None) -> Loc:
    """인용구의 원문 오프셋 [start, end). 실패는 QuoteError(E_QUOTE_SHORT | E_QUOTE_NOT_FOUND | E_QUOTE_AMBIGUOUS).

    window: 모델이 본 원문 구간 [(시작, 끝)](표시 본문 코드포인트). 없으면(에이전트 제출 묶음) 문서 전체 규칙 그대로다.
    있으면 문서 전체에서 여러 곳이고 prefix, suffix로도 못 좁힐 때만 창 안의 적중으로 좁힌다.
    창 안에서 정확히 1곳이면 그곳이다. 창 안 2곳 이상이거나 0곳이면 E_QUOTE_AMBIGUOUS이고 첫 적중을 고르지 않는다.
    문서 전체에서 1곳이거나 prefix, suffix로 1곳이 되는 경우는 창과 무관하게 이전과 같다."""
    q = fold(quote or "")
    if len(q) < MIN_QUOTE:
        raise QuoteError("E_QUOTE_SHORT", f"인용구 {len(q)}자 < {MIN_QUOTE}")
    folded, idx = _folded(text)
    hits, i = [], folded.find(q)
    cap = MAX_WINDOW_HITS if window else MAX_HITS            # 창 안 적중이 MAX_HITS 밖에 있을 수 있다
    while i >= 0 and len(hits) < cap:
        hits.append(i)
        i = folded.find(q, i + 1)
    over = i >= 0                                            # 상한을 넘겨 더 있다
    if not hits:
        raise QuoteError("E_QUOTE_NOT_FOUND", "표시 본문에 인용구가 없다")
    if len(hits) > 1:
        p, s = fold(prefix or ""), fold(suffix or "")

        def narrow(hs):
            return [h for h in hs if (not p or folded[:h].rstrip().endswith(p))
                    and (not s or folded[h + len(q):].lstrip().startswith(s))]
        n_all = len(hits)
        narrowed = narrow(hits) if (p or s) else hits
        if (p or s) and len(narrowed) == 1:
            hits = narrowed
        elif not window or ((p or s) and not narrowed):
            if not (p or s):
                raise QuoteError("E_QUOTE_AMBIGUOUS", f"{n_all}곳에 있다. prefix, suffix가 필요하다")
            raise QuoteError("E_QUOTE_AMBIGUOUS", f"prefix, suffix로 좁혀도 {len(narrowed)}곳이다")
        else:
            if over:
                raise QuoteError("E_QUOTE_AMBIGUOUS", f"적중이 {cap}곳을 넘어 창 안에서 좁히지 않는다")
            spans = window_spans(text, window)
            inw = [h for h in narrowed
                   if any(a <= idx[h] and idx[h + len(q) - 1] + 1 <= b for a, b in spans)]
            if len(inw) != 1:
                raise QuoteError("E_QUOTE_AMBIGUOUS", f"문서에 {n_all}곳, 창 안에 {len(inw)}곳이다")
            hits = inw
    h = hits[0]
    return Loc(idx[h], idx[h + len(q) - 1] + 1)
