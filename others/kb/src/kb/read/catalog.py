"""/v1/schema 와 /v1/meta (WP-04). 타입 카탈로그는 gold의 type_def에서 읽고 파일을 읽지 않는다."""
from __future__ import annotations

import json

from kb.read.ctx import ReadCtx, row, rows, visibility_sql
from kb.read.envelope import changes_cursor

CONTRACT = "v1"
BUILTIN_GROUP = {
    **dict.fromkeys("Platform Product Feature Tool Repo Package Model Org Person Channel Video Keyword Metric Concept Technique Policy".split(), "world"),
    **dict.fromkeys(["Source", "Document", "Snapshot"], "evidence"),
    **dict.fromkeys(["Claim", "Series"], "fact"),
    **dict.fromkeys("Note Decision Artifact Learning Project Record".split(), "user"),
    "Ticket": "ops",
}
# type_def에 x-kb-overview가 없을 때의 초기값(ADR 7.3). 그 밖의 타입은 group=user만 true.
OVERVIEW_DEFAULT = set("Platform Product Feature Tool Model Org Concept Technique Policy Series".split())
EDGE_GROUP = {
    **dict.fromkeys("ABOUT OBJECT EVIDENCED_BY CLAIMED_BY".split(), "claim"),
    **dict.fromkeys(["SNAPSHOT_OF", "PUBLISHED_BY"], "source"),
    **dict.fromkeys("SUPERSEDES CONFLICTS_WITH RENAMED_TO MERGED_INTO SUCCESSOR_OF FORK_OF".split(), "change"),
    **dict.fromkeys("PART_OF HAS_FEATURE USES RUNS_ON DEPENDS_ON MEASURES".split(), "structure"),
    **dict.fromkeys("LINKS_TO MENTIONS DECIDED_IN PRODUCED_BY".split(), "user"),
    **dict.fromkeys(["ANSWERS", "REQUESTS_ABOUT"], "request"),
}
ENUMS = {
    "origin": ["external", "first_party"],
    "sensitivity": ["public", "internal", "private", "secret"],
    "status": ["active", "superseded", "dead"],
    "selector_kind": ["text_quote", "jsonpointer"],
    "claim_kind": ["event", "state", "howto"],
    "hit_kind": ["claim", "record", "entity", "passage"],
    "stance": ["stated", "attributed"],
    "method": ["deterministic", "llm", "human"],
    "precision": ["instant", "day", "month", "quarter", "year"],
    "evidence_state": ["live", "archived_only"],
}
COMMON_SORT = ["id", "label", "recorded_at"]
FILTER_KEYS = ["types", "origin", "status", "domain", "source", "author"]


def _defs(con, kind: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rows(con, "SELECT name, version, schema_json, status FROM type_def WHERE kind=? ORDER BY name, version", (kind,)):
        try:
            sc = json.loads(r["schema_json"]) if r["schema_json"] else {}
        except ValueError:
            sc = {}
        out[r["name"]] = {"version": r["version"], "schema": sc, "status": r["status"]}
    return out


def _prop_type(spec: dict) -> tuple[str, bool]:
    t, arr = spec.get("type"), False
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    if t == "array":
        arr = True
        spec = spec.get("items") or {}
        t = spec.get("type")
        if isinstance(t, list):
            t = next((x for x in t if x != "null"), "string")
    if t == "integer":
        return "integer", arr
    if t == "number":
        return "decimal", arr
    if t == "boolean":
        return "boolean", arr
    if t == "string" and spec.get("format") in ("date-time", "date"):
        return "date-time", arr
    return "string", arr


def type_properties(con) -> dict[str, dict[str, dict]]:
    """타입 이름 -> {속성 이름: {type, filterable, sortable, array}}.
    filterable 기본은 true(`x-kb-filterable: false`로 끈다), sortable 기본은 false(`x-kb-sortable: true`로 켠다)."""
    out: dict[str, dict] = {}
    for name, d in _defs(con, "node").items():
        props = {}
        for pn, spec in ((d["schema"].get("properties") or {}).items()):
            if not isinstance(spec, dict):
                continue
            t, arr = _prop_type(spec)
            props[pn] = {"type": t, "array": arr, "filterable": spec.get("x-kb-filterable", True) is not False,
                         "sortable": spec.get("x-kb-sortable", False) is True and not arr}
        out[name] = props
    return out


def _group(name: str, schema: dict) -> str | None:
    return schema.get("x-kb-group") or BUILTIN_GROUP.get(name)


def _in_overview(name: str, group: str, schema: dict) -> bool:
    v = schema.get("x-kb-overview")
    if isinstance(v, bool):
        return v
    if name in OVERVIEW_DEFAULT:
        return True
    return group == "user"


def _plain(ctx: ReadCtx) -> ReadCtx:
    return ctx.with_(types=None, exclude_types=(), origin=None, domains=None, sources=None, authors=None, edge_status=None)


def _observed_groups(con, ctx: ReadCtx):
    w, p = visibility_sql(_plain(ctx), "n")
    counts = {r["type"]: r["c"] for r in rows(con, f"SELECT n.type, COUNT(*) c FROM node n WHERE {w} GROUP BY n.type", p)}
    worldish = {r["type"] for r in rows(con, "SELECT DISTINCT type FROM node WHERE id LIKE 'e:%'")}
    return counts, worldish


def overview_types(con, ctx: ReadCtx | None = None) -> list[str]:
    ctx = ctx or ReadCtx()
    defs = _defs(con, "node")
    counts, worldish = _observed_groups(con, ctx)
    names = set(defs) | set(counts)
    out = []
    for name in sorted(names):
        sc = defs.get(name, {}).get("schema", {})
        g = _group(name, sc) or ("world" if name in worldish else "user")
        if defs.get(name, {}).get("status") == "deprecated":
            continue
        if _in_overview(name, g, sc):
            out.append(name)
    return out


def catalog(con, ctx: ReadCtx) -> dict:
    defs = _defs(con, "node")
    counts, worldish = _observed_groups(con, ctx)
    props = type_properties(con)
    ov = set(overview_types(con, ctx))
    node_types, sort_keys = [], {"*": list(COMMON_SORT)}
    for name in sorted(set(defs) | set(counts)):
        d = defs.get(name)
        sc = d["schema"] if d else {}
        g = _group(name, sc) or ("world" if name in worldish else "user")
        plist = [{"name": pn, "type": s["type"], "filterable": s["filterable"], "sortable": s["sortable"]}
                 for pn, s in sorted(props.get(name, {}).items())]
        nt = {"name": name, "group": g, "count": counts.get(name, 0), "status": d["status"] if d else "provisional",
              "in_overview": name in ov, "properties": plist}
        if sc:
            nt["json_schema"] = sc
        node_types.append(nt)
        sort_keys[name] = COMMON_SORT + [x["name"] for x in plist if x["sortable"]]
    edefs = _defs(con, "edge")
    ew, ep = visibility_sql(_plain(ctx), "e", kind="edge")
    ecounts = {r["rtype"]: r["c"] for r in rows(con, f"SELECT e.rtype, COUNT(*) c FROM edge e WHERE {ew} GROUP BY e.rtype", ep)}
    edge_types = []
    for name in sorted(set(edefs) | set(ecounts)):
        sc = edefs.get(name, {}).get("schema", {})
        et = {"name": name, "group": sc.get("x-kb-group") or EDGE_GROUP.get(name, "fact"), "count": ecounts.get(name, 0)}
        if sc.get("x-kb-from"):
            et["from"] = list(sc["x-kb-from"])
        if sc.get("x-kb-to"):
            et["to"] = list(sc["x-kb-to"])
        edge_types.append(et)
    nw, np_ = visibility_sql(_plain(ctx), "n")
    preds = [r["predicate"] for r in rows(
        con, f"SELECT DISTINCT c.predicate FROM claim c JOIN node n ON n.vid=c.vid WHERE c.predicate IS NOT NULL AND {nw} ORDER BY 1", np_)]
    return {
        "node_types": node_types, "edge_types": edge_types,
        "predicates": [{"id": p, "functional": False, "value_kind": None, "labels": {}} for p in preds],
        "overview_types": sorted(ov), "enums": {k: list(v) for k, v in ENUMS.items()},
        "sort_keys": sort_keys, "filter_keys": list(FILTER_KEYS),
    }


def _kb_version() -> str:
    try:
        from importlib.metadata import version
        return version("sagae-kb")
    except Exception:
        return "0.1.0"


def meta(con, ctx: ReadCtx, *, concurrent: int = 16) -> dict:
    """/v1/meta. counts는 숨김과 기본 필터를 지난 값이다. concurrent는 서빙 층의 동시 상한(read.max_concurrent)이다."""
    pl = _plain(ctx)
    nw, np_ = visibility_sql(pl.with_(exclude_types=("Claim", "Snapshot", "Source", "Document", "Ticket")), "n")
    nodes = row(con, f"SELECT COUNT(*) c FROM node n WHERE {nw}", np_)["c"]
    cw, cp = visibility_sql(pl.with_(types=("Claim",)), "n")
    claims = row(con, f"SELECT COUNT(*) c FROM node n WHERE {cw}", cp)["c"]
    ew, ep = visibility_sql(pl, "e", kind="edge")
    edges = row(con, f"SELECT COUNT(*) c FROM edge e WHERE {ew}", ep)["c"]
    fw, fp = visibility_sql(pl.with_(origin=("first_party",)), "n")
    fpo = row(con, f"SELECT 1 x FROM node n WHERE {fw} LIMIT 1", fp) is not None
    from kb.core import ledger
    led = ledger.open_ledger()
    try:
        fp_gate = ledger.meta_get(led, "fp_open") is not None
    finally:
        led.close()
    from kb.write.secrets_scan import editor_rule_contract
    from kb.write import reviewer
    hitl, _ = reviewer.trust_status()
    try:
        rules = editor_rule_contract()
    except (OSError, ValueError, KeyError):
        rules = {"version": None, "sha": None}
    return {"contract": CONTRACT, "kb_version": _kb_version(),
            "write": {"fp_gate": fp_gate,
                      "editor_routes": ["POST /v1/records", "PUT /v1/records/{id}",
                                        "POST /v1/records/{id}/tombstone", "GET /v1/writes/{ref}", "DELETE /v1/writes/{ref}"] if rules["sha"] else [],
                      "private_open": False, "hitl": hitl,
                      "secret_rules": rules},
            "limits": {"overview_nodes": 100000, "overview_edges": 400000, "page": 500, "concurrent": concurrent},
            "changes_cursor": changes_cursor(con), "first_party_open": fpo,
            "counts": {"nodes": nodes, "edges": edges, "claims": claims}}
