"""인용 게이트 check_claim(ADR 10.6). 제출 묶음과 L2가 같은 함수를 지난다. 전부 결정적이다.

순서: 8(주입) -> 3(인용구 위치) -> 7(판단어) -> 4(값) -> 5(주어 문맥) -> 9(생존). 거부는 즉시 반환하고,
4, 5, 9단계 실패는 거부가 아니라 needs_review로 모아 저장한다. 통과하면 verification=quote_found.
quote_found는 인용구가 기계로 확인됐다는 뜻이지 주장이 참이라는 뜻이 아니다."""
from __future__ import annotations

from kb.gate import context, judgement, values
from kb.gate.liveness import CODE as LIVE_CODE
from kb.gate.model import GateCtx, GateResult
from kb.gate.textmatch import QuoteError, locate


def _para_for(paras, start: int):
    for p in paras or ():
        a, b = (p.start_cp, p.end_cp) if hasattr(p, "start_cp") else (p["start_cp"], p["end_cp"])
        if a <= start < b:
            return p
    return None


def _attr(o, k, default=None):
    return getattr(o, k, None) if hasattr(o, k) else (o.get(k, default) if isinstance(o, dict) else default)


def check_claim(claim: dict, text: str, paras, ctx: GateCtx, window=None) -> GateResult:
    """claim: statement, quote(없으면 evidence[0].exact), prefix, suffix, kind, stance, speaker.
    text: 표시 본문, paras: kb.parse.paragraphs.Para 목록, ctx: GateCtx.
    window: L2가 모델에 보인 원문 구간 [(시작, 끝)]. 인용구가 문서에 여러 곳일 때만 창 안으로 좁힌다(textmatch.locate)."""
    st = claim.get("statement") or ""
    ev0 = (claim.get("evidence") or [{}])[0] if isinstance(claim.get("evidence"), list) else (claim.get("evidence") or {})
    quote = claim.get("quote") or ev0.get("quote") or ev0.get("exact") or ""
    prefix = claim.get("prefix", ev0.get("prefix", "")) or ""
    suffix = claim.get("suffix", ev0.get("suffix", "")) or ""
    kind, stance, speaker = claim.get("kind") or "state", claim.get("stance") or "stated", claim.get("speaker")

    why = judgement.injection(st, quote)                                              # 8
    if why:
        return GateResult("rejected", "E_INJECTION", why, ["E_INJECTION"], quarantine=True)
    try:
        loc = locate(text, quote, prefix, suffix, window)                                      # 3
    except QuoteError as e:
        return GateResult("rejected", e.code, e.detail, [e.code])
    exact = text[loc.start:loc.end]
    res = GateResult("accepted", verification="quote_found", start_cp=loc.start, end_cp=loc.end, exact=exact,
                     stance=stance, speaker=speaker)

    words = judgement.judgement_words(st)                                              # 7
    if words or kind == "howto" or stance == "attributed":
        res.judgement = bool(words)
        if not speaker:
            speaker = ctx.publisher or None
        if not speaker:
            why = "판단어 문장의 화자를 소스 발행처로 확정할 수 없다" if words else \
                  "howto, attributed 주장의 화자(speaker)를 확정할 수 없다"
            return GateResult("rejected", "E_JUDGEMENT", why, ["E_JUDGEMENT"], judgement=bool(words),
                              start_cp=loc.start, end_cp=loc.end, exact=exact)
        res.stance, res.speaker = "attributed", speaker

    codes, details = [], []
    vi = values.value_issues(st, exact, ctx.subject_aliases)                                                # 4
    if vi:
        codes.append("R_VALUE_MISMATCH")
        details.append("문장의 값이 인용구와 다르다: " + "; ".join(vi))
    para = _para_for(paras, loc.start)                                                 # 5
    ptxt = text[_attr(para, "start_cp"):_attr(para, "end_cp")] if para is not None else ""
    hay = context.build_hay(exact, ptxt, _attr(para, "table_header"), _attr(para, "heading_path"), ctx.doc_title,
                           ctx.source_names)
    if not context.subject_in_context(ctx.subject_aliases, hay):
        codes.append("R_SUBJECT_CONTEXT")
        details.append("주어 별칭이 인용구, 문단, 표 머리, 절 제목, 문서 제목에 없다")
    bad = context.alias_conflicts(st, ctx.subject, ctx.subject_aliases, ctx.known_aliases, hay) if ctx.known_aliases else []
    if bad:
        codes.append("R_ALIAS_MISMATCH")
        details.append("문장의 다른 엔티티 별칭이 근거에 없다: " + ", ".join(bad[:3]))
    if ctx.liveness is not None and ctx.subject and kind != "event":                    # 9. event는 시점이 붙은 역사적 사실이라 생존 보류에서 뺀다(ADR 9.2, 2026-11-01 사용자 결정)
        if ctx.liveness(ctx.subject) == LIVE_CODE:
            codes.append(LIVE_CODE)
            details.append("G 단위 주어의 생존 상태가 없다")
    if codes:
        res.result, res.verification = "needs_review", "needs_review"
        res.code, res.detail, res.codes = codes[0], " | ".join(details), codes
    return res
