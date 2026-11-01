"""골든 평가기(WP-18). eval/golden/*.jsonl의 사람이 확인한 표본만 쓴다.
표본 한 줄: {"id","kind": query|extract|stale_premise,"verified_by":"human:<이름>", ...}. verified_by가 human:으로 시작하지 않거나
origin이 모델/자기 출력(model|llm|self|kb|kb_output|auto)이면 거부한다(자기 출력으로 만든 정답 금지).
  query:         {q, expect_ids:[...], k?}                       -> recall@k, mrr
  extract:       {text, expect:[{subject,object?}...], recall_sample?:bool}
                 -> 정밀도, 재현율. recall_sample=true인 표본은 recall_sample 항목에 따로 잰다
  stale_premise: {premise, annotation, correct: bool}            -> 맞는 값 수용률, 틀린 값 수용률
함수는 주입한다: search_fn(q)->[id], extract_fn(text)->[{subject,object}], accept_fn(case)->bool."""
from __future__ import annotations

import json
from pathlib import Path

SELF_ORIGINS = {"model", "llm", "self", "kb", "kb_output", "auto", "generated"}
KINDS = ("query", "extract", "stale_premise")


class SelfGeneratedGold(ValueError):
    pass


def check_case(c: dict) -> str | None:
    """거부 사유. 통과면 None."""
    if c.get("kind") not in KINDS:
        return "kind"
    vb = str(c.get("verified_by") or "")
    if not vb.startswith("human:") or len(vb) <= 6:
        return "not_human_verified"
    if str(c.get("origin") or "").lower() in SELF_ORIGINS:
        return "self_generated"
    return None


def load_cases(path: Path, *, strict: bool = False) -> tuple[list[dict], list[dict]]:
    """(통과, 거부[{id, why}]). strict면 거부가 하나라도 있으면 SelfGeneratedGold."""
    files = sorted(path.glob("*.jsonl")) if path.is_dir() else [path]
    ok, bad = [], []
    for f in files:
        for i, ln in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if not ln.strip():
                continue
            try:
                c = json.loads(ln)
            except ValueError:
                bad.append({"id": f"{f.name}:{i}", "why": "bad_json"})
                continue
            why = check_case(c) if isinstance(c, dict) else "not_object"
            if why:
                bad.append({"id": str((c or {}).get("id", f"{f.name}:{i}")) if isinstance(c, dict) else f"{f.name}:{i}", "why": why})
            else:
                ok.append(c)
    if strict and bad:
        raise SelfGeneratedGold(f"거부된 표본 {len(bad)}건: {bad[:3]}")
    return ok, bad


def _ratio(a: int, b: int) -> float:
    return round(a / b, 4) if b else 0.0


def _match(item: dict, exp: dict) -> bool:
    return item.get("subject") == exp.get("subject") and ("object" not in exp or item.get("object") == exp.get("object"))


def evaluate(cases: list[dict], *, search_fn=None, extract_fn=None, accept_fn=None) -> dict:
    q_hit = q_tot = 0
    mrr = 0.0
    q_n = 0
    tp = fp = fn = 0
    rs_tp = rs_fn = rs_n = 0
    acc = {"correct": [0, 0], "wrong": [0, 0]}
    for c in cases:
        k = c["kind"]
        if k == "query" and search_fn:
            q_n += 1
            got = list(search_fn(c["q"]))[: int(c.get("k", 10))]
            exp = set(c.get("expect_ids") or [])
            q_hit += len(exp & set(got))
            q_tot += len(exp)
            rank = next((i for i, g in enumerate(got, 1) if g in exp), 0)
            mrr += 1.0 / rank if rank else 0.0
        elif k == "extract" and extract_fn:
            got = list(extract_fn(c["text"]))
            exp = list(c.get("expect") or [])
            m = sum(1 for e in exp if any(_match(g, e) for g in got))
            extra = sum(1 for g in got if not any(_match(g, e) for e in exp))
            if c.get("recall_sample"):
                rs_n += 1
                rs_tp += m
                rs_fn += len(exp) - m
            else:
                tp += m
                fn += len(exp) - m
                fp += extra
        elif k == "stale_premise" and accept_fn:
            slot = acc["correct" if c.get("correct") else "wrong"]
            slot[1] += 1
            slot[0] += 1 if accept_fn(c) else 0
    return {
        "cases": len(cases),
        "query": {"n": q_n, "recall_at_k": _ratio(q_hit, q_tot), "mrr": round(mrr / q_n, 4) if q_n else 0.0},
        "extract": {"precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn), "tp": tp, "fp": fp, "fn": fn},
        "recall_sample": {"n": rs_n, "recall": _ratio(rs_tp, rs_tp + rs_fn)},
        "stale_premise": {"accept_correct": _ratio(*acc["correct"]), "accept_wrong": _ratio(*acc["wrong"]),
                          "n_correct": acc["correct"][1], "n_wrong": acc["wrong"][1]},
    }


def run_suite(suite: str, root: Path, **fns) -> dict:
    d = root / suite
    cases, rejected = load_cases(d) if d.exists() else ([], [])
    out = evaluate(cases, **fns)
    out.update(suite=suite, rejected=len(rejected), rejected_why=sorted({r["why"] for r in rejected}))
    return out
