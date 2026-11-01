"""kb.read.search가 부르는 kb-rank 클라이언트(표준 라이브러리만). search(q, ctx, *, kinds, limit) -> Ranked | None.

None이면 호출자가 어휘 경로(r=l)로 내려간다: 소켓이 없거나, 연결 실패, 8초 안에 첫 답이 없을 때.
순서(ADR 14.2): 어휘 10 + 사실 Dense 15 + 문단 Dense 10 + 엔티티의 현재 주장 5의 합집합 -> 재순위(r=h, 로짓 하한 -2).
재순위가 없으면 Dense 순서 뒤에 어휘 전용 결과를 잇는다(r=c). 점수는 어디에도 내보내지 않는다.
kb-rank는 공개 ID만 돌려주므로 가시성 필터(민감도, 상태, 검증, 시간축, 종류)는 여기서 코어 술어로 다시 건다.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

from kb.rank import conf, fusion, proto, units

_LETTER = {"claim": "c", "record": "r", "entity": "e", "passage": "p"}


@dataclass(frozen=True)
class Ranked:
    ids: list[str] = field(default_factory=list)
    route: str = "h"   # h: 재순위, c: Dense 순서 뒤 어휘 전용


def _ask(sock, req: dict, deadline: float) -> dict | None:
    out = proto.call(sock, req, deadline)
    return out if out.get("ok") is True else None


def _entity_claims(con, ctx, q: str, S, limit: int) -> list[str]:
    from kb.core.text import nfc
    from kb.read import aliases
    words = nfc(q).lower().split()
    keys: set[str] = set()
    for n in range(1, min(aliases.MAX_WINDOW, len(words)) + 1):
        for i in range(len(words) - n + 1):
            w = " ".join(words[i:i + n])
            keys.add(aliases.key(w))
            keys.add(aliases.key(w.replace(" ", "")))
    if not keys:
        return []
    try:
        nodes = [r[0] for r in con.execute("SELECT DISTINCT node_id FROM alias WHERE norm IN (SELECT value FROM json_each(?))", (json.dumps(sorted(keys)),))]
    except Exception:  # noqa: BLE001 alias 표가 없는 gold
        return []
    if not nodes:
        return []
    w, p = S._where(ctx, ("claim",))
    sql = (f"SELECT {S._KEY} AS hk FROM span s WHERE s.ref_kind='claim' AND s.subject IN (SELECT value FROM json_each(?)) AND {w} "
           f"ORDER BY s.sid LIMIT ?")
    return list(dict.fromkeys(r[0] for r in con.execute(sql, [json.dumps(nodes), *p, limit])))


def _allowed(con, ctx, ks, ids: list[str], S) -> dict[str, tuple]:
    """Dense가 돌려준 ID 중 코어 필터를 통과하는 것. {id: (ref_kind, snapshot_id, start_cp, end_cp)}"""
    if not ids:
        return {}
    w, p = S._where(ctx, ks)
    sql = (f"SELECT {S._KEY} AS hk, s.ref_kind AS rk, s.snapshot_id AS sn, s.start_cp AS a, s.end_cp AS b FROM span s "
           f"JOIN unit u ON u.rid=s.unit_rid WHERE {w} AND {S._KEY} IN (SELECT value FROM json_each(?)) ORDER BY s.sid")
    out: dict[str, tuple] = {}
    for r in con.execute(sql, [*p, json.dumps(ids)]):
        out.setdefault(r[0], (r[1], r[2], r[3], r[4]))
    return out


def _promote(con, ctx, ordered: list[str], info: dict, S) -> list[str]:
    """문단이 이기면 그 문단 안의 주장 카드로 승격한다(주장 ID를 문단 앞에 둔다). 없으면 발췌 카드(문단 그대로)."""
    w, p = S._where(ctx, ("claim",))
    sql = (f"SELECT s.ref_id FROM span s WHERE s.ref_kind='claim' AND s.snapshot_id=? AND s.start_cp>=? AND s.end_cp<=? AND {w} "
           f"ORDER BY s.sid LIMIT 1")
    out: list[str] = []
    seen = set(ordered)
    for k in ordered:
        inf = info.get(k)
        if inf and inf[0] == "document" and inf[1] is not None:
            r = con.execute(sql, [inf[1], inf[2], inf[3], *p]).fetchone()
            if r and r[0] not in seen:
                seen.add(r[0])
                out.append(r[0])
        out.append(k)
    return out


def search(q: str, ctx, *, kinds=None, limit: int = 50) -> Ranked | None:
    sock = conf.sock_path()
    if not os.path.exists(sock):
        return None
    from kb.read import search as S
    from kb.read.ctx import reading
    ks = tuple(kinds) if kinds else S.KINDS
    want = {_LETTER[k] for k in ks if k in _LETTER}
    deadline = time.monotonic() + conf.CLIENT_TIMEOUT_S
    try:
        fact = _ask(sock, {"op": "embed_search", "q": q, "k": conf.CAND_FACT, "kind": "fact"}, deadline) if want & set(conf.FACT) else {"ids": []}
        if fact is None:
            return None
        psg = _ask(sock, {"op": "embed_search", "q": q, "k": conf.CAND_PASSAGE, "kind": "passage"}, deadline) if "p" in want else {"ids": []}
        if psg is None:
            return None
    except (OSError, ValueError, TimeoutError):
        return None
    try:
        with reading(ctx) as con:
            lex = [it["id"] for it in S.search_in(con, ctx, q, mode="lexical", kinds=ks, limit=conf.CAND_LEX)[0]["items"]]
            dense = _allowed(con, ctx, ks, list(dict.fromkeys([*fact["ids"], *psg["ids"]])), S)
            df = [i for i in fact["ids"] if i in dense][:conf.CAND_FACT]
            dp = [i for i in psg["ids"] if i in dense][:conf.CAND_PASSAGE]
            ent = _entity_claims(con, ctx, q, S, conf.CAND_ENTITY) if "c" in want else []
            cands = fusion.pool(df, dp, lex, ent)
            route, ordered = "c", cands
            texts = units.texts_for(con, cands)
            try:
                rr = _ask(sock, {"op": "rerank", "q": q, "texts": [texts.get(c, "")[:conf.RERANK_CHARS] for c in cands]}, deadline) if cands else None
                if rr is not None and len(rr.get("logits", [])) == len(cands):
                    route, ordered = "h", fusion.rerank_order(cands, [float(x) for x in rr["logits"]])
            except (OSError, ValueError, TimeoutError):
                pass
            info = {**dense}
            if "p" in want and "c" in want:
                info.update({k: v for k, v in _allowed(con, ctx, ("passage",), [c for c in ordered if c not in info], S).items()})
                ordered = _promote(con, ctx, ordered, info, S)
            return Ranked(ids=ordered, route=route)
    except Exception:  # noqa: BLE001 조회는 실패하지 않는다. 어휘로 강등한다.
        return None
