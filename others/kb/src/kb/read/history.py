"""/v1/nodes/{id}/history (WP-04): 버전 행과 술어·슬롯별 대체 체인. 두 시간축을 모두 보여 준다."""
from __future__ import annotations

from kb.read.ctx import AsOfUnsupported, ReadCtx, chunks, group_of, iso, rows, visibility_sql
from kb.read.nodes import target_row, valid_obj


def _item(r: dict, sup: dict) -> dict:
    return {"id": r["id"], "version": r["version"], "status": r["eff_status"], "own_status": r["status"],
            "status_basis": "own" if r["status"] == r["eff_status"] else "subject", "value": r["value"], "unit": r["unit"],
            "valid": valid_obj(r), "recorded_at": iso(r["recorded_at"]), "expired_at": iso(r["expired_at"]),
            "superseded_by": sup.get(r["id"]) if r["expired_at"] is None else None}


def history(con, ctx: ReadCtx, nid: str, *, predicate: str | None = None) -> dict:
    if ctx.as_of_valid is not None or ctx.as_of_observed is not None:
        raise AsOfUnsupported("history는 as_of_*를 받지 않는다")
    top = target_row(con, ctx, nid, mode="versions")
    vw, vp = visibility_sql(ctx, "n", mode="versions")
    versions = [{"version": r["version"], "label": r["label"], "status": r["status"], "recorded_at": iso(r["recorded_at"]),
                 "expired_at": iso(r["expired_at"])}
                for r in rows(con, f"SELECT n.* FROM node n WHERE n.id=? AND {vw} ORDER BY n.version", [nid, *vp])]
    hw, hp = visibility_sql(ctx, "n", mode="history")
    cols = "n.*, c.subject, c.predicate, c.slot, c.value, c.unit"
    if top["type"] == "Claim":
        key = rows(con, "SELECT subject, predicate, slot FROM claim WHERE vid=?", (top["vid"],))[0]
        sql = (f"SELECT {cols} FROM node n JOIN claim c ON c.vid=n.vid WHERE c.subject=? AND c.predicate IS ? "
               f"AND c.slot IS ? AND {hw}")
        args = [key["subject"], key["predicate"], key["slot"], *hp]
    else:
        g = group_of(con, nid)
        sql = f"SELECT {cols} FROM node n JOIN claim c ON c.vid=n.vid WHERE c.subject IN ({','.join('?' * len(g))}) AND {hw}"
        args = [*g, *hp]
    if predicate:
        sql += " AND c.predicate=?"
        args.append(predicate)
    crows = rows(con, sql, args)
    cids = sorted({r["id"] for r in crows})
    ew, ep = visibility_sql(ctx, "e", kind="edge", mode="history")
    erows: list[dict] = []
    for ch in chunks(cids, 400):
        ph = ",".join("?" * len(ch))
        erows += rows(con, f"SELECT e.* FROM edge e WHERE e.rtype='SUPERSEDES' AND (e.src IN ({ph}) OR e.dst IN ({ph})) AND {ew} "
                           f"ORDER BY e.recorded_at, e.id", [*ch, *ch, *ep])
    sup: dict[str, str] = {}
    for e in erows:
        sup.setdefault(e["dst"], e["src"])
    chains: dict[tuple, list] = {}
    for r in crows:
        chains.setdefault((r["predicate"], r["slot"]), []).append(r)
    out = []
    for (pred, slot), items in sorted(chains.items(), key=lambda kv: (kv[0][0] or "", kv[0][1] or "")):
        items.sort(key=lambda r: (r["recorded_at"], r["id"], r["version"]))
        out.append({"predicate": pred, "slot": slot, "items": [_item(r, sup) for r in items]})
    seen, edges = set(), []
    for e in erows:
        if e["id"] not in seen:
            seen.add(e["id"])
            edges.append({"id": e["id"], "rtype": e["rtype"], "src": e["src"], "dst": e["dst"], "status": e["status"],
                          "claim_id": e["claim_id"]})
    return {"id": nid, "versions": versions, "chains": out, "edges": edges}
