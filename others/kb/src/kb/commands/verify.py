"""kb verify chain|cas|projection|all."""
from __future__ import annotations

import json
import re

from kb.core import cas, ledger
from kb.core import conn as _conn
from kb.project import verify_projection

SHA = re.compile(r"^[0-9a-f]{64}$")
# window_sha는 넣지 않는다. 창 본문의 내용 해시(캐시 키)일 뿐 CAS 객체가 아니다. 본문은 스냅샷 문단에서 다시 만든다.
# 창을 CAS에 넣으면 ttl 스냅샷 본문이 영구 객체로 남는다.
CAS_KEYS = {"raw_sha": None, "text_sha": None, "paras_sha": None, "points_sha": None, "output_sha": None,
            "body_sha": "fp"}


def _led():
    return _conn.connect_ro(ledger.ledger_path(), deadline_s=600.0)


def verify_chain() -> dict:
    c = _led()
    try:
        r = ledger.verify_chain(c)
        return {"ok": bool(r.ok), "events": r.events, "head_seq": r.head_seq, "errors": r.errors[:20]}
    finally:
        c.close()


def verify_cas() -> dict:
    """원장이 가리키는 CAS 객체가 있고 온전한가. 원장 밖 객체의 변조도 본다."""
    c = _led()
    try:
        want: dict[tuple[str, str], int] = {}
        for seq, kind, body in c.execute("SELECT e.seq, e.kind, p.body FROM event e JOIN payload p ON p.sha=e.payload_sha"):
            pl = json.loads(body)
            if not isinstance(pl, dict):
                continue
            tier = "ttl" if pl.get("tier") == "ttl" else "objects"
            for k, t in CAS_KEYS.items():
                v = pl.get(k)
                if isinstance(v, str) and SHA.match(v):
                    want.setdefault((t or tier, v), seq)
            for v in pl.get("para_shas") or []:
                pass  # 문단 해시는 객체가 아니라 색인 항목이다
    finally:
        c.close()
    missing, corrupt = [], []
    for (tier, sha), seq in sorted(want.items(), key=lambda x: x[1]):
        if not cas.exists(sha, tier):
            missing.append({"sha": sha, "tier": tier, "seq": seq})
        elif not cas.verify(sha, tier):
            corrupt.append({"sha": sha, "tier": tier, "seq": seq})
    return {"ok": not missing and not corrupt, "referenced": len(want), "missing": missing[:50], "corrupt": corrupt[:50]}


def run(what: str) -> dict:
    parts = {"chain": verify_chain, "cas": verify_cas, "projection": verify_projection}
    names = list(parts) if what == "all" else [what]
    out = {n: parts[n]() for n in names}
    if what == "all":
        return {"ok": all(v.get("ok") for v in out.values()), **out}
    return out[what]


def cmd_verify(args) -> int:
    rep = run(args.what)
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, sort_keys=True))
    else:
        for k, v in rep.items():
            print(f"{k}: {v}")
    return 0 if rep.get("ok") else 1


def register(sub) -> None:
    p = sub.add_parser("verify", help="원장 체인, CAS, gold 투영 검증")
    p.add_argument("what", choices=["chain", "cas", "projection", "all"])
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_verify)
