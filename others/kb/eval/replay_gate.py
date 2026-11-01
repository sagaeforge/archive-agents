"""저장된 L2 주장 재생(읽기 전용, LLM 호출 없음). live gold와 CAS를 읽기만 하고 아무것도 쓰지 않는다.
각 L2 주장(extractor가 l2:로 시작하는 현재 노드)을 현재 코드의 check_claim에 다시 통과시켜 통과율과 사유 분포를 낸다.
실행: KB_LIVE=1 KB_HOME=/home/user/sagae-kb-data ops/bin/dev python eval/replay_gate.py [--detail]
주어 별칭은 gold에 저장된 라벨+별칭이다. 생존(R_LIVENESS_UNKNOWN)은 재생하지 않는다."""
from __future__ import annotations

import sys
from collections import Counter

from kb.collect import registry
from kb.gate import GateCtx, check_claim
from kb.gate.context import norm
from kb.ingest.store import Gold, SnapInfo, load_text


def source_names(src) -> tuple:
    if src is None:
        return ()
    raw = src.raw or {}
    out = [src.name, raw.get("publisher"), *(raw.get("aliases") or [])]
    return tuple(x for x in dict.fromkeys(out) if x)


def main() -> int:
    detail = "--detail" in sys.argv
    gold = Gold()
    con = gold.conn()
    sources = {s.id: s for s in registry.load_registry(validate=False)}
    rows = con.execute(
        "SELECT n.id, n.verification, c.subject, c.statement, c.kind, c.stance, c.speaker, c.extractor, "
        "e.snapshot_id, e.exact, e.prefix, e.suffix FROM node n JOIN claim c ON c.vid=n.vid "
        "JOIN evidence e ON e.claim_id=n.id WHERE n.expired_at IS NULL AND c.extractor LIKE 'l2:%' "
        "GROUP BY n.id ORDER BY n.id").fetchall()
    known = dict(gold.all_aliases())
    cache: dict = {}
    tally, codes, bad = Counter(), Counter(), []
    for (cid, ver, subj, st, kind, stance, speaker, ext, snap, exact, pre, suf) in rows:
        if snap not in cache:
            n = gold.node(snap)
            props = n["props"] if n else {}
            src = sources.get(props.get("source") or "")
            pub = (src.raw.get("publisher") or src.name or None) if src is not None else None
            info = SnapInfo(id=snap, url=props.get("url") or "", source=props.get("source") or "", trust="", publisher=pub, props=props)
            try:
                load_text(info, sources, write=False)
            except Exception as e:  # noqa: BLE001
                info = None
                bad.append((cid, repr(e)[:80]))
            cache[snap] = (info, src)
        info, src = cache[snap]
        if info is None:
            tally["skip"] += 1
            continue
        sn = gold.node(subj)
        forms = tuple([sn["label"], *[x[0] for x in con.execute("SELECT norm FROM alias WHERE node_id=?", (subj,))]]) if sn else ()
        kw = {"source_names": source_names(src)} if "source_names" in GateCtx.__dataclass_fields__ and "--base" not in sys.argv else {}
        ctx = GateCtx(subject=subj, subject_aliases=forms, known_aliases=known, doc_title=info.title, publisher=info.publisher, **kw)
        r = check_claim({"statement": st, "kind": kind, "stance": stance, "speaker": speaker, "quote": exact,
                         "prefix": pre or "", "suffix": suf or ""}, info.text, info.paras, ctx)
        tally[r.result] += 1
        if "--neg" in sys.argv and any("neg" in x for x in (r.detail or "").split(";")[-1:]):
            print("NEG", cid, "\n  ST:", st, "\n  Q:", exact.replace("\n"," "))
        for c in r.codes:
            codes[c] += 1
        if detail and r.result != "accepted":
            print(cid, r.codes, "|", (r.detail or "")[:150], "|", st[:90], "|", (exact or "")[:90].replace("\n", " "))
    total = sum(v for k, v in tally.items() if k != "skip")
    print("total", total, dict(tally), "pass_rate", round(tally["accepted"] / total, 3) if total else None)
    print("codes", dict(codes))
    if bad:
        print("skipped", bad[:3])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
