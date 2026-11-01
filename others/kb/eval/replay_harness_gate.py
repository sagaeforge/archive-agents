"""하네스 표본(~/.cache/sagae-kb/llm-eval)의 저장된 모델 출력을 운영 게이트 check_claim에 다시 통과시킨다. 읽기 전용, LLM 호출 없음.
주어 별칭은 후보 라벨(또는 subject_new 라벨+별칭) 그대로이고 토큰 분해는 하지 않는다(운영과 같다). 출처 이름은 발행처다.
심판이 num_wrong, subject_wrong으로 판정한 주장이 통과하는 수를 함께 센다(왜곡 통과).
실행: ops/bin/dev python eval/replay_harness_gate.py"""
from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter

from kb.gate import GateCtx, check_claim
from kb.gate.context import norm
from kb.parse.paragraphs import paragraphs

ROOT = os.path.expanduser("~/.cache/sagae-kb/llm-eval")
BAD = {"num_wrong", "subject_wrong"}


def main() -> int:
    wins = {}
    for x in open(f"{ROOT}/harness/sample/windows.jsonl", encoding="utf-8"):
        if x.strip():
            w = json.loads(x)
            wins[w["window_id"]] = w
    tot, acc, codes = 0, 0, Counter()
    dist_n = dist_pass = 0
    per = {}
    for cf in sorted(glob.glob(f"{ROOT}/results/*/*/claims.jsonl")):
        run = cf.split("/results/")[1].rsplit("/", 1)[0]
        verdict = {}
        jf = os.path.join(os.path.dirname(cf), "judged.jsonl")
        if os.path.exists(jf):
            verdict = {j["claim_id"]: j.get("verdict") for j in map(json.loads, filter(str.strip, open(jf, encoding="utf-8")))}
        n = a = 0
        for line in open(cf, encoding="utf-8"):
            if not line.strip():
                continue
            r = json.loads(line)
            c, w = r.get("claim"), wins.get(r.get("window_id"))
            if not c or not w:
                continue
            labels = {x["id"]: x["label"] for x in w["candidates"]}
            if c.get("subject") == "__new__":
                sn = c.get("subject_new") or {}
                forms = [sn.get("label") or "", *(sn.get("aliases") or [])]
            else:
                forms = [labels.get(c.get("subject"), "")]
            known = {norm(v): k for k, v in labels.items() if len(norm(v)) >= 3 and not any("가" <= ch <= "힣" for ch in v)}
            ctx = GateCtx(subject=c.get("subject") or "", subject_aliases=tuple(f for f in forms if f), known_aliases=known,
                          doc_title=w.get("title") or "", publisher=w.get("publisher"),
                          **({"source_names": (w.get("publisher"),)} if "source_names" in GateCtx.__dataclass_fields__ and "--base" not in sys.argv else {}))
            res = check_claim({k: c.get(k) for k in ("statement", "quote", "kind", "stance", "speaker")},
                              w["text"], paragraphs(w["text"], "markdown"), ctx)
            n += 1
            a += res.accepted
            for code in res.codes:
                codes[code] += 1
            if verdict.get(r["claim_id"]) in BAD:
                dist_n += 1
                dist_pass += res.accepted
        per[run] = (a, n)
        tot += n
        acc += a
    for run, (a, n) in per.items():
        print(f"{run}: {a}/{n} = {a / n:.3f}" if n else run)
    print(f"전체 {acc}/{tot} = {acc / tot:.3f}; 심판 왜곡 주장 {dist_n}건 중 통과 {dist_pass}건")
    print("사유", dict(codes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
