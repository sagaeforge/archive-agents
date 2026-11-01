"""왜곡 고정 표본 생성기. 실제 주장 49건(tests/fixtures/gate/gate_rows.json)에서 X6 방식으로 왜곡을 만든다.
출력 tests/gate/data/distortion.json은 고정 표본이다. 표본은 subject 필드를 유지한다(바뀐 이름을 subject로 넘기지 않는다).
실행: ops/bin/dev python tests/gate/make_distortion.py [--check]"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "fixtures" / "gate"))
from t5_tables import CMP, NEG, SUBJ, UNIT  # noqa: E402

NUM = re.compile(r"\d[\d,\.]*\d|\d")
TAMPER = [("할 수 있다", "할 수 없다"), ("이상", "이하"), ("부터", "까지"), ("필요", "불필요"), ("포함", "제외")]


def build(rows: list) -> list:
    out = []

    def add(cat, i, st=None, quote=None):
        r = rows[i]
        out.append({"cat": cat, "row": i, "page": r["page"], "subject": r["subject"],
                    "statement": st if st is not None else r["statement"],
                    "quote": quote if quote is not None else r["quote"]})

    for i, r in enumerate(rows):
        s = r["statement"]
        for cat, tbl in (("부정 반전", NEG), ("비교 반전", CMP), ("단위 교체", UNIT)):
            for a, b in tbl:
                if a in s:
                    add(cat, i, s.replace(a, b, 1))
                    break
        for a, b in SUBJ:
            if a in s:
                add("주어 교체", i, s.replace(a, b, 1))
                break
        ns = list(NUM.finditer(s))
        if len({m.group(0) for m in ns}) >= 2 and ns[0].group(0) != ns[1].group(0):
            a, b = ns[0], ns[1]
            add("숫자 교차", i, s[:a.start()] + b.group(0) + s[a.end():b.start()] + a.group(0) + s[b.end():])
        if ns:
            m = ns[0]
            v = m.group(0)
            add("숫자 변경(대조군)", i, s[:m.start()] + v[:-1] + str((int(v[-1]) + 1) % 10) + s[m.end():])
        # 인용구 변조: 인용구 안의 낱말 하나를 바꾸거나 가운데를 잘라 이어 붙인다. 표시 본문에 그대로 있을 수 없다
        q = r["quote"]
        for a, b in TAMPER:
            if a in q:
                add("인용구 변조", i, quote=q.replace(a, b, 1))
                break
        else:
            mid = len(q) // 2
            add("인용구 변조", i, quote=q[:mid] + " 임의삽입어 " + q[mid:])
    return out


def main() -> int:
    rows = json.loads((HERE.parent / "fixtures" / "gate" / "gate_rows.json").read_text(encoding="utf-8"))
    data = build(rows)
    p = HERE / "data" / "distortion.json"
    text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    if "--check" in sys.argv:
        return 0 if p.read_text(encoding="utf-8") == text else 1
    p.write_text(text, encoding="utf-8")
    cnt: dict = {}
    for d in data:
        cnt[d["cat"]] = cnt.get(d["cat"], 0) + 1
    print(cnt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
