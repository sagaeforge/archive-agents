"""결정적 주장의 대체와 충돌(ADR 7.4, 7.6). 순수 함수 resolve와 gold 조회 도우미.

- 같은 슬롯, 같은 출처, 함수형 술어, 값이 다름 -> 옛 주장을 claim.supersede.
- 같은 슬롯, 다른 출처, 함수형 술어, 값이 다름 -> 공존 + CONFLICTS_WITH 엣지. 시스템이 승자를 정하지 않는다.
- 새 값의 valid_from이 미래 -> 옛 주장은 superseded가 되지 않고 valid_to만 닫힌 새 버전(claim.assert)으로 남는다.
  효력일이 지난 뒤의 대체 완결은 5단계 confirm이 한다.
- 새 값의 valid_from이 옛 값보다 앞서면(소급 정정) 옛 주장을 두고 새 주장의 valid.to를 옛 값의 valid_from으로 닫는다.
LLM 주장은 대상이 아니다(method=deterministic만 부른다).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from kb.core import ids
from kb.core.canon import canon_json, sha256_hex

ACTOR = "parser"


def slot_of(subject: str, predicate: str, qualifiers: dict | None) -> str:
    return "sl-" + sha256_hex(canon_json([subject, predicate, qualifiers or {}]))[:16]


@dataclass
class Resolution:
    events: list = field(default_factory=list)
    new_valid_to: str | None = None       # 새 주장 payload의 valid.to로 넣을 값(소급 정정)
    notes: list = field(default_factory=list)


def _ms(s) -> int | None:
    if s in (None, ""):
        return None
    from kb.project.apply import parse_time
    return parse_time(s)[0]


def resolve(new: dict, source: str | None, existing: list[dict], functional: bool, now_ms: int) -> Resolution:
    """new: claim.assert payload. existing: [{id, source, value, valid_from, valid_to, payload?}] (valid_*는 ISO 문자열 또는 ms).
    source: 새 주장의 출처 id. 반환 events는 idem_key 없는 초안(kind, payload)이다."""
    res = Resolution()
    if not functional:
        return res
    nid = new["id"]
    nfrom = (new.get("valid") or {}).get("from")
    nfrom_ms = _ms(nfrom)
    for old in existing:
        if old["id"] == nid or old.get("value") == new.get("value"):
            continue
        if (old.get("source") or None) != (source or None):
            res.events.append({"kind": "edge.put", "payload": {
                "id": ids.edge_id(nid, "CONFLICTS_WITH", old["id"]), "src": nid, "rtype": "CONFLICTS_WITH", "dst": old["id"]}})
            res.notes.append(f"conflict:{old['id']}")
            continue
        ofrom_ms = _ms(old.get("valid_from"))
        if nfrom_ms is not None and nfrom_ms > now_ms:
            if old.get("payload"):
                p = json.loads(json.dumps(old["payload"]))
                p.setdefault("valid", {})["to"] = nfrom
                res.events.append({"kind": "claim.assert", "payload": p})
                res.notes.append(f"future:{old['id']}")
            continue
        if nfrom_ms is not None and ofrom_ms is not None and nfrom_ms < ofrom_ms:
            res.new_valid_to = old.get("valid_from") if isinstance(old.get("valid_from"), str) else None
            res.notes.append(f"retroactive:{old['id']}")
            continue
        p = {"id": old["id"], "by": nid, "reason": "value_changed"}
        if nfrom:
            p["valid_to"] = nfrom
        res.events.append({"kind": "claim.supersede", "payload": p})
        res.notes.append(f"supersede:{old['id']}")
    return res


def _iso(ms) -> str | None:
    if ms is None:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_existing(slot: str) -> list[dict]:
    """gold에서 이 슬롯의 활성 결정적 주장. gold가 없으면 빈 목록."""
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    p = current_gold_path()
    if not p:
        return []
    con = connect_ro(p)
    try:
        rows = con.execute(
            "SELECT n.id, n.vid, n.valid_from, n.valid_to, n.verification, c.subject, c.predicate, c.object, c.value, c.unit, "
            "c.qualifiers, c.statement, c.kind, c.stance, c.speaker, c.method, c.slot, c.extractor, "
            "(SELECT s.source_id FROM span s WHERE s.ref_id=n.id AND s.rec_to IS NULL LIMIT 1) "
            "FROM node n JOIN claim c ON c.vid=n.vid "
            "WHERE c.slot=? AND n.type='Claim' AND n.expired_at IS NULL AND n.status='active' AND c.method='deterministic'",
            (slot,)).fetchall()
        out = []
        for (cid, vid, vf, vt, ver, subj, pred, obj, val, unit, qual, stmt, kind, stance, spk, meth, sl, ext, src) in rows:
            evs = con.execute("SELECT snapshot_id, selector_kind, exact, prefix, suffix, start_cp, end_cp, json_pointer, text_sha, "
                              "gate_version FROM evidence WHERE claim_id=? ORDER BY id", (cid,)).fetchall()
            ev = []
            for (sn, sk, ex, pf, sf, a, b, jp, ts, gv) in evs:
                d = {"snapshot": sn, "selector_kind": sk, "gate_version": gv or ""}
                for k, v in (("exact", ex), ("prefix", pf), ("suffix", sf), ("start_cp", a), ("end_cp", b), ("json_pointer", jp),
                             ("text_sha", ts)):
                    if v is not None:
                        d[k] = v
                ev.append(d)
            payload = {"id": cid, "subject": subj, "statement": stmt, "kind": kind, "stance": stance, "method": meth,
                       "verification": ver, "slot": sl, "evidence": ev}
            for k, v in (("predicate", pred), ("object", obj), ("value", val), ("unit", unit), ("speaker", spk), ("extractor", ext)):
                if v is not None:
                    payload[k] = v
            if qual:
                payload["qualifiers"] = json.loads(qual)
            valid = {}
            if vf is not None:
                valid["from"] = _iso(vf)
            if vt is not None:
                valid["to"] = _iso(vt)
            if valid:
                payload["valid"] = valid
            out.append({"id": cid, "source": src, "value": val, "valid_from": _iso(vf), "valid_to": _iso(vt), "payload": payload})
        return out
    finally:
        con.close()


def functional_predicates() -> set[str]:
    import yaml
    from kb.core import paths
    d = yaml.safe_load((paths.share_dir() / "schemas" / "predicates.yaml").read_text(encoding="utf-8")) or {}
    return {p["id"] for p in d.get("predicates", []) if p.get("functional")}
