"""모델 출력 -> 적재 계약 claim 항목. 모든 백엔드의 출력이 같은 kb.ingest -> kb.gate.check_claim을 지난다.
모델별 분기와 문턱을 두지 않는다(ADR-0003 1장, 10장)."""
from __future__ import annotations

from kb.extract.types import Window

PRODUCER = "agent:l2"


def extractor_id(backend: str, model: str, prompt_version: str) -> str:
    return f"l2:{backend}:{model}:{prompt_version}"


def to_items(w: Window, claims: list, extractor: str, domains: list | None = None) -> list:
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
        if c.get("valid_from"):
            it["valid"] = {"from": c["valid_from"]}
        if c.get("changed_on"):
            it["changed_on"] = c["changed_on"]
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
