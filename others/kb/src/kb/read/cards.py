"""MCP용 사실 카드(WP-04). ADR 15.2의 탭 구분 형식이고 출처는 슬러그 인라인이다.

#kb v1 seq=<applied_seq> asof=<날짜> r=<경로> n=<카드 수> more=<남은 수> [cur=<커서>]
<id>\\t<한 문장>\\t<출처 슬러그>\\t<유효 시점>\\t<표시 기호>
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from kb.read.budget import DEFAULT_BUDGET, clean, est_tokens, take
from kb.read.ctx import ReadCtx, chunks, iso, rows, visibility_sql
from kb.read.envelope import applied_seq, data_as_of, make_cursor
from kb.read.nodes import _json

ANNOT_MONTHS = 24
SOURCE_ANNOT_OK = ("quote_found", "parser_derived")
CONTRACT = "v1"


@dataclass
class CardResult:
    text: str
    n: int
    more: int
    cur: str | None
    tokens: int
    ids: list = field(default_factory=list)


def _slug(source_id: str | None) -> str:
    s = source_id or ""
    return s[4:] if s.startswith("src:") else s


def _date(ms: int | None) -> str:
    return iso(ms)[:10] if ms is not None else ""


def _months_ago(ref_ms: int, months: int) -> int:
    d = datetime.fromtimestamp(ref_ms // 1000, tz=timezone.utc)
    y, m = d.year, d.month - months
    while m <= 0:
        y, m = y - 1, m + 12
    day = min(d.day, 28)
    return int(d.replace(year=y, month=m, day=day).timestamp() * 1000)


def _author_mark(author: str | None) -> str:
    if author and author.startswith("agent:"):
        return "f:agent:" + author[6:]
    return "f:user"


def _liveness_mark(liveness: str | None, props: dict, valid_to: int | None) -> str | None:
    if liveness == "stale_suspect":
        return "suspect"
    if liveness == "deprecated":
        return "dep"
    if liveness == "scheduled_removal":
        d = _date(valid_to) or props.get("removal_date") or ""
        return "sched:" + str(d) if d else "sched"
    if liveness == "partial":
        c = props.get("condition")
        return "partial:" + clean(c) if c else "partial"
    return None


def render_cards(con, ctx: ReadCtx, ids, *, budget: int = DEFAULT_BUDGET, route: str = "h", more: int = 0,
                 cur: str | None = None, edges: bool = False, start: int = 0) -> CardResult:
    """ID 순서대로 카드를 만든다. 보이지 않거나 active가 아닌(superseded, dead) 항목은 건너뛴다.
    예산을 넘으면 뒤 카드를 통째로 빼고 more, cur를 머리에 준다. more와 cur는 호출자의 이어받기 값에 더해진다."""
    ids = list(dict.fromkeys(ids))
    cctx = ctx.with_(types=None, exclude_types=(), origin=None, domains=None, sources=None, authors=None)
    w, p = visibility_sql(cctx, "n")
    found: dict[str, dict] = {}
    for ch in chunks(ids, 500):
        for r in rows(con, f"SELECT n.* FROM node n WHERE n.id IN ({','.join('?' * len(ch))}) AND {w}", [*ch, *p]):
            found[r["id"]] = r
    seq = applied_seq(con)
    ref = data_as_of(con, seq)
    cands = [found[i] for i in ids if i in found and found[i]["eff_status"] == "active"]
    claim_vids = [r["vid"] for r in cands if r["type"] == "Claim"]
    crow = {}
    for ch in chunks(claim_vids, 500):
        for r in rows(con, f"SELECT * FROM claim WHERE vid IN ({','.join('?' * len(ch))})", ch):
            crow[r["vid"]] = r
    lines: list[str] = []
    rendered: list[str] = []
    claim_ids = [r["id"] for r in cands if r["type"] == "Claim"]
    ev_src = _evidence_sources(con, claim_ids)
    for r in cands:
        lines.append(_card(con, cctx, r, crow.get(r["vid"]), ev_src.get(r["id"], []), ref))
        rendered.append(r["id"])
    edge_lines: list[list[str]] = [[] for _ in lines]
    if edges and claim_ids:
        ew, ep = visibility_sql(cctx, "e", kind="edge")
        seen = set()
        for ch in chunks(claim_ids, 500):
            for e in rows(con, f"SELECT e.* FROM edge e WHERE e.claim_id IN ({','.join('?' * len(ch))}) AND {ew} ORDER BY e.id", [*ch, *ep]):
                if e["id"] in seen:
                    continue
                seen.add(e["id"])
                i = rendered.index(e["claim_id"])
                edge_lines[i].append(f"~ {e['src']} -{e['rtype']}-> {e['dst']}")
    blocks = ["\n".join([lines[i], *edge_lines[i]]) for i in range(len(lines))]
    tok = [est_tokens(b) + 1 for b in blocks]
    reserve = est_tokens(_header(seq, ref, route, 9999, 99999, "x" * 60)) + 1
    k = take(tok, max(budget - reserve, 0))
    left = len(blocks) - k
    new_cur = cur
    if left > 0:
        new_cur = make_cursor(con, ctx, k=start + k, fh_parts=["cards", route, ids])
    header = _header(seq, ref, route, k, more + left, new_cur)
    text = "\n".join([header, *blocks[:k]])
    return CardResult(text=text, n=k, more=more + left, cur=new_cur, tokens=est_tokens(text), ids=rendered[:k])


def _header(seq, ref, route, n, more, cur) -> str:
    h = f"#kb {CONTRACT} seq={seq} asof={_date(ref) or '-'} r={route} n={n} more={more}"
    return h + (f" cur={cur}" if cur else "")


def _evidence_sources(con, claim_ids) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {c: [] for c in claim_ids}
    for ch in chunks(claim_ids, 400):
        for r in rows(con, f"SELECT ev.claim_id, ev.evidence_state, s.props FROM evidence ev LEFT JOIN node s ON s.id=ev.snapshot_id "
                           f"AND s.expired_at IS NULL WHERE ev.claim_id IN ({','.join('?' * len(ch))}) ORDER BY ev.claim_id, ev.id", ch):
            out[r["claim_id"]].append((_json(r["props"]).get("source") or "", r["evidence_state"]))
    return out


def _chain(con, ctx, subject, predicate, slot):
    w, p = visibility_sql(ctx.with_(status="all"), "n")
    return rows(con, f"SELECT n.id, n.eff_status, n.valid_from, n.valid_to, c.value, c.kind FROM node n JOIN claim c ON c.vid=n.vid "
                     f"WHERE c.subject=? AND c.predicate IS ? AND c.slot IS ? AND {w}", [subject, predicate, slot, *p])


def _card(con, ctx, r: dict, c: dict | None, evs: list, ref) -> str:
    marks: list[str] = []
    ver = r["verification"]
    if r["type"] == "Claim" and c is not None:
        sent = clean(c["statement"])
        srcs = [s for s, _ in evs if s]
        slug = _slug(srcs[0]) if srcs else ""
        uniq = list(dict.fromkeys(srcs))
        vf, vt = r["valid_from"], r["valid_to"]
        valid = (f"{_date(vf)}~{_date(vt)}" if vt is not None else f"{_date(vf)}~") if vf is not None or vt is not None else ""
        if ver == "quote_found":
            marks.append("q")
        elif ver == "parser_derived":
            marks.append("p")
        elif ver == "first_party":
            marks.append(_author_mark(r["author"]))
        else:
            marks.append("u")
        if r["sensitivity"] == 1:
            marks.append("internal")
        if c["stance"] == "attributed":
            marks.append("a")
        if len(uniq) > 1:
            marks.append(f"+{len(uniq) - 1}src")
        if c["predicate"]:
            ch = _chain(con, ctx, c["subject"], c["predicate"], c["slot"])
            grp = c["conflict_group"]
            others = {x["value"] for x in ch if x["eff_status"] == "active" and x["id"] != r["id"] and x["value"] != c["value"]}
            if grp:
                marks.append(f"!g{grp}")
            elif others:
                marks.append(f"!g{len(others) + 1}")
            hist = len({x["id"] for x in ch if x["eff_status"] == "superseded" and x["id"] != r["id"]})
            if hist:
                marks.append(f"hist:{hist}")
        if any(st == "archived_only" for _, st in evs):
            marks.append("stale")
        subj = rows(con, "SELECT liveness, props, valid_to FROM node WHERE id=? AND expired_at IS NULL", (c["subject"],))
        if subj:
            lm = _liveness_mark(subj[0]["liveness"], _json(subj[0]["props"]), subj[0]["valid_to"])
            if lm:
                marks.append(lm)
        if c["kind"] in ("state", "howto") and ref is not None:
            sent += _annotation(con, ctx, r["id"], c["subject"], ref)
    else:
        sent = clean(r["label"])
        a = r["author"] or ""
        slug = "user" if a.startswith("user:") or not a else "agent"
        valid = _date(r["valid_from"])
        if ver == "first_party" or r["origin"] == "first_party":
            marks.append(_author_mark(r["author"]))
        elif ver == "quote_found":
            marks.append("q")
        elif ver == "parser_derived":
            marks.append("p")
        if r["sensitivity"] == 1:
            marks.append("internal")
        lm = _liveness_mark(r["liveness"], _json(r["props"]), r["valid_to"])
        if lm:
            marks.append(lm)
    return "\t".join([clean(r["id"]), sent, clean(slug), valid, ",".join(marks)])


def _annotation(con, ctx, cid: str, subject: str, ref: int) -> str:
    """낡은 전제 주석: 같은 주어의 24개월 안 활성 event 주장을 출처 귀속 괄호로 붙인다.
    인용구 또는 결정적 파서 근거(quote_found, parser_derived)가 있는 주장만 쓴다. 근거 없는 주장과 superseded 값은 쓰지 않는다."""
    w, p = visibility_sql(ctx.with_(status="active", include_unverified=False), "n")
    lo = _months_ago(ref, ANNOT_MONTHS)
    ev = rows(con, f"SELECT n.id, n.verification, n.valid_from, n.recorded_at, c.statement FROM node n JOIN claim c ON c.vid=n.vid "
                   f"WHERE c.subject=? AND c.kind='event' AND n.id<>? AND {w} ORDER BY n.id", [subject, cid, *p])
    outs = []
    for e in ev:
        if e["verification"] not in SOURCE_ANNOT_OK:
            continue
        t = e["valid_from"] if e["valid_from"] is not None else e["recorded_at"]
        if t < lo:
            continue
        srcs = _evidence_sources(con, [e["id"]]).get(e["id"], [])
        slug = _slug(next((s for s, _ in srcs if s), ""))
        if not slug:
            continue
        outs.append(f"(출처 {slug}에 따르면 {clean(e['statement'])})")
    return (" " + " ".join(outs)) if outs else ""
