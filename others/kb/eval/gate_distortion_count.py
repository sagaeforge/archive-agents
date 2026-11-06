"""tests/gate 왜곡 표본의 게이트 통과 수(범주별). 읽기 전용. 실행: ops/bin/dev python eval/gate_distortion_count.py"""
import json
from collections import Counter

from tests.gate import helpers as H

rows = H.rows()
data = json.loads((H.DATA / "distortion.json").read_text(encoding="utf-8"))
acc, tot = Counter(), Counter()
for d in data:
    r = H.run(rows[d["row"]], d["statement"], d["quote"])
    tot[d["cat"]] += 1
    acc[d["cat"]] += r.accepted
for c in tot:
    print(f"{c}: 통과 {acc[c]}/{tot[c]}")
print("왜곡 5범주 통과 합", sum(acc[c] for c in tot if c in ("부정 반전", "비교 반전", "단위 교체", "주어 교체", "숫자 교차")), "/90")
