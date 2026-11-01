"""모델 출력 -> 적재 계약 claim 항목. 모든 백엔드의 출력이 같은 kb.ingest -> kb.gate.check_claim을 지난다.
모델별 분기와 문턱을 두지 않는다(ADR-0003 1장, 10장)."""
from __future__ import annotations

import re

from kb.extract.types import Window

PRODUCER = "agent:l2"


def extractor_id(backend: str, model: str, prompt_version: str) -> str:
    return f"l2:{backend}:{model}:{prompt_version}"


def two_digit_year(v, quote: str, year_max: int | None) -> str | None:
    """허용 목록(2026-11-01). 값이 정확히 '25년' 또는 '25년도'이고, 인용구에 정확히 '(25년)'(바로 앞이 숫자 또는 %) 또는 '25년도'(앞이 숫자가 아님)가
    있으며, 20YY가 스냅샷 연도 이하일 때만 '2025'를 낸다. 그 밖의 값('경력 25년', '창립 25년', '25년간', '지난 10년' 등)은 추측하지 않고
    None이다. 호출자는 바꾸지 않은 값을 그대로 적재 단계에 넘기고 거기서 E_SCHEMA를 받는다."""
    m = re.fullmatch(r"(\d{2})년(도?)", str(v or "").strip())
    if m is None or year_max is None or not quote:
        return None
    yy = m.group(1)
    if not re.search(rf"(?<=[\d%])\({yy}년\)|(?<!\d){yy}년도", quote):
        return None
    y = 2000 + int(yy)
    return str(y) if y <= year_max else None


def to_items(w: Window, claims: list, extractor: str, domains: list | None = None, year_max: int | None = None,
             normalized: dict | None = None) -> list:
    """L2 변환. 시각 필드는 허용 목록 하나만 바꾼다: '25년'/'25년도'가 인용구의 '(25년)'/'25년도'와 맞고 스냅샷 연도를 넘지 않으면 '2025'.
    그 밖의 값은 건드리지 않아 적재 단계에서 E_SCHEMA를 받는다(에이전트 묶음과 같다). normalized는 필드별 건수다."""
    out = []
    cand = {c["id"] for c in w.candidates}
    labels = {c["label"].lower(): c["id"] for c in w.candidates}
    for i, c in enumerate(claims):
        it = {"item": "claim", "ref": f"c{i}", "subject": c["subject"], "predicate": c.get("predicate"),
              "statement": c["statement"], "kind": c["kind"], "stance": c["stance"], "method": "llm", "extractor": extractor,
              "evidence": {"snapshot": w.snapshot, "quote": c["quote"]}}
        if c["subject"] == "__new__":
            sn = c.get("subject_new") or {}
            if not sn.get("label"):
                continue
            it["subject_new"] = {"label": sn["label"], "type": sn.get("type") or "Concept", "aliases": list(sn.get("aliases") or [])}
        if c["stance"] == "attributed":
            it["speaker"] = c.get("speaker") or w.publisher or None
            if not it["speaker"]:
                it.pop("speaker")
        elif c.get("speaker"):
            it["speaker"] = c["speaker"]
        for k in ("value", "unit"):
            if c.get(k) is not None:
                it[k] = str(c[k])
        if c.get("qualifier"):
            it["qualifiers"] = {"qualifier": c["qualifier"]}
        if c.get("prior_value"):
            it.setdefault("qualifiers", {})["prior_value"] = c["prior_value"]
        for field, put in (("valid_from", lambda v: it.__setitem__("valid", {"from": v})),
                           ("changed_on", lambda v: it.__setitem__("changed_on", v))):
            v = c.get(field)
            if not v:
                continue
            y = two_digit_year(v, c.get("quote") or "", year_max)
            if y is not None:
                put(y)
                if normalized is not None:
                    normalized[field] = normalized.get(field, 0) + 1
            else:
                put(v)
        dep = c.get("depends_on")
        if dep:
            did = dep if dep in cand else labels.get(str(dep).lower())
            if did:
                it["depends_on"] = [did]
        if domains:
            it["domain"] = list(domains)
        out.append(it)
    return out


def bundle(w_sha: str, items: list, domains: list | None = None) -> list:
    h = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": f"l2-{w_sha[:24]}", "producer": PRODUCER}
    if domains:
        h["domain"] = list(domains)
    return [h, *items]
