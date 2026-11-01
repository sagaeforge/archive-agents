"""어휘 검색(WP-05). 한국어, 영어 어휘 경로를 KB 안에서 끝낸다. 표준 라이브러리와 SQLite FTS5만 쓴다.

질의: NFC, 소문자 -> 별칭 확장(aliases.py) -> core.text 토큰화 -> 전 토큰 AND -> 결과가 K_OR 미만이면 OR 결과를 뒤에 잇는다.
FTS 식은 토큰마다 큰따옴표 구문이다. unicode61이 `2_1_314`를 `2 1 314`로 쪼개도 색인 쪽이 같은 문자열을 같은 규칙으로 쪼개므로
구문 질의 `"2_1_314"`가 찾힌다(tests/search/test_version_phrase.py).

두 경로
- 상위 400 경로(기본 필터만, as-of 없음): FTS 상위 400을 서브쿼리로 뽑고 span을 조인한다. total=null, 400이 찼으면 truncated.
- 필터 경로(그 밖): 안쪽 LIMIT 없이 필터 후 순위를 매긴다. total은 정확한 개수다.

bm25 값은 정렬에만 쓰고 응답과 커서에 넣지 않는다. 커서는 순위 위치 + 앵커 id + 필터 해시 + epoch이다.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Iterator

from kb.core import cas, config
from kb.core.text import nfc, query_tokens
from kb.read import aliases
from kb.read.ctx import SENS_NAME, BadParam, ReadCtx, iso, reading, rows, visibility_sql
from kb.read.envelope import clamp_limit, envelope, make_cursor, page_obj, read_cursor
from kb.read.facets import facets as _facets
from kb.read.snapshots import source_ref
from kb.read.snippet import make_snippet

KINDS = ("claim", "record", "entity", "passage")
_KIND_REF = {"claim": "claim", "record": "record", "entity": "node", "passage": "document"}
_REF_KIND = {v: k for k, v in _KIND_REF.items()}
K_OR = 10          # AND 결과가 이보다 적으면 OR 결과를 잇는다
CAP = 400          # 상위 N 경로의 후보 수
RARE_N = 8
SELECTIVE = 20_000   # 필터를 통과하는 단위가 이보다 적으면 필터를 먼저 걸고 그 단위만 순위를 매긴다
ANCHOR_SCAN = 5000
HYBRID_POOL = 2000


# ------------------------------------------------------------------ 질의 계획

@dataclass
class Plan:
    q: str
    terms: list[list[list[str]]]            # 항 -> 대안 -> 토큰
    words: list[str] = field(default_factory=list)   # 하이라이트용 문자열(별칭 대안 포함)

    def tokens(self) -> list[str]:
        out: list[str] = []
        for t in self.terms:
            for alt in t:
                out.extend(alt)
        return list(dict.fromkeys(out))

    def and_expr(self) -> str:
        parts = []
        for alts in self.terms:
            segs = [" AND ".join(_quote(t) for t in alt) for alt in alts]
            if len(segs) == 1:
                parts.append(segs[0])
            else:
                parts.append("(" + " OR ".join(f"({s})" for s in segs) + ")")
        return " AND ".join(parts)

    def or_expr(self, tokens: list[str] | None = None) -> str:
        return " OR ".join(_quote(t) for t in (tokens if tokens is not None else self.tokens()))


def _quote(tok: str) -> str:
    return '"' + tok.replace('"', '""') + '"'


def build_plan(q: str, con=None) -> Plan:
    qn = nfc(q or "").lower()
    words = qn.split()
    extra = aliases.entity_forms(con, words) if con is not None else None
    terms: list[list[list[str]]] = []
    hl: list[str] = []
    for seg in aliases.expand(words, extra):
        alts: list[list[str]] = []
        for text in (seg.text, *seg.alts):
            toks = query_tokens(text)
            if toks and toks not in alts:
                alts.append(toks)
                hl.append(text)
        if alts:
            terms.append(alts)
    if not terms:
        raise BadParam("검색어에서 토큰이 하나도 나오지 않는다", "q")
    return Plan(q=" ".join(words), terms=terms, words=hl)


def lexical_ids(con: sqlite3.Connection, plan: Plan, *, k: int = K_OR, topk: int = 100, table: str = "fts") -> list[int]:
    """fts 표만 있는 연결에서 AND 후 OR로 rowid 순위를 낸다. 평가 스크립트와 시험이 쓴다(span, 필터 없음)."""
    def run(expr: str) -> list[int]:
        return [r[0] for r in con.execute(
            f"SELECT rowid FROM {table} WHERE {table} MATCH ? ORDER BY rank LIMIT ?", (expr, topk))]
    a = run(plan.and_expr())
    if len(a) >= k:
        return a
    seen = set(a)
    return a + [x for x in run(plan.or_expr()) if x not in seen]


# ------------------------------------------------------------------ 규모 게이트

def _doc_freq(con, subs: list[str]) -> dict[str, int]:
    """토큰 -> 문서 빈도. gold의 영구 표 fts_vocab(fts5vocab 'row')을 읽는다. 읽기 전용 연결에서도 된다."""
    ph = ",".join("?" * len(subs))
    return {r[0]: r[1] for r in con.execute(f"SELECT term, doc FROM fts_vocab WHERE term IN ({ph})", subs)}


def _rare_tokens(con, tokens: list[str]) -> list[str]:
    """문서 빈도가 낮은 토큰 RARE_N개. 색인에 없는 토큰은 OR에 기여하지 않으므로 뺀다."""
    subs_of = {t: _split_unicode61(t) for t in tokens}
    all_subs = sorted({s for v in subs_of.values() for s in v})
    df = _doc_freq(con, all_subs) if all_subs else {}
    score: dict[str, int] = {}
    for t, subs in subs_of.items():
        if subs and all(s in df for s in subs):
            score[t] = min(df[s] for s in subs)
    return sorted(score, key=lambda t: (score[t], t))[:RARE_N]


def _split_unicode61(tok: str) -> list[str]:
    out, cur = [], []
    for ch in tok:
        if ch.isalnum():
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


# ------------------------------------------------------------------ 후보 흐름

_COLS = ("s.sid, s.ref_id, s.ref_kind, s.unit_rid, u.kind AS ukind, s.subject, s.type, s.origin, s.eff_status, s.verification, "
         "s.sensitivity, s.start_cp, s.end_cp, s.snapshot_id, s.source_id")
_KEY = "CASE WHEN s.ref_kind='document' THEN s.snapshot_id||':'||s.start_cp ELSE s.ref_id END"


def _where(ctx: ReadCtx, kinds: tuple) -> tuple[str, list]:
    w, p = visibility_sql(ctx, "s", kind="span")
    if len(kinds) < len(KINDS):
        refs = [_KIND_REF[k] for k in kinds]
        w += f" AND s.ref_kind IN ({','.join('?' * len(refs))})"
        p = [*p, *refs]
    return w, p


def _is_default(ctx: ReadCtx, kinds: tuple) -> bool:
    return (ctx.status == "active" and not ctx.include_unverified and ctx.as_of_valid is None and ctx.as_of_observed is None
            and not (ctx.types or ctx.exclude_types or ctx.origin or ctx.domains or ctx.sources or ctx.authors)
            and len(kinds) == len(KINDS))


class _Stream:
    """AND 단계 뒤에 필요하면 OR 단계를 잇는 중복 없는 히트 흐름. 앞에서부터 필요한 만큼만 읽는다."""

    def __init__(self, con, ctx: ReadCtx, plan: Plan, kinds: tuple, capped: bool):
        self.con, self.ctx, self.plan, self.kinds, self.capped_path = con, ctx, plan, kinds, capped
        self.buf: list[dict] = []
        self.done = False
        self.hit_cap = False
        self._cand = 0   # 0: 아직 안 봄, None: 선택적이지 않음, str: 후보 단위 rowid의 JSON 배열
        self._gen = self._run()

    def _candidates(self) -> str | None:
        """필터 경로에서 필터를 통과하는 단위가 적으면(희귀 필터) 그 rowid 목록. 순위 계산을 후보로 좁힌다."""
        if self._cand == 0:
            self._cand = None
            if not self.capped_path:
                w, p = _where(self.ctx, self.kinds)
                got = [r[0] for r in self.con.execute(f"SELECT s.unit_rid FROM span s WHERE {w} LIMIT ?", [*p, SELECTIVE + 1])]
                if len(got) <= SELECTIVE:
                    self._cand = json.dumps(got)
        return self._cand

    def _stage(self, expr: str) -> Iterator[dict]:
        w, p = _where(self.ctx, self.kinds)
        if self.capped_path:
            probe = self.con.execute("SELECT COUNT(*) FROM (SELECT 1 FROM fts WHERE fts MATCH ? LIMIT ?)", (expr, CAP + 1)).fetchone()[0]
            if probe > CAP:
                self.hit_cap = True
            inner = "SELECT rowid AS rid, rank FROM fts WHERE fts MATCH ? ORDER BY rank, rowid LIMIT ?"
            ip = [expr, CAP]
        elif (cand := self._candidates()) is not None:
            inner = "SELECT rowid AS rid, rank FROM fts WHERE fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))"
            ip = [expr, cand]
        else:
            inner = "SELECT rowid AS rid, rank FROM fts WHERE fts MATCH ?"
            ip = [expr]
        sql = (f"WITH m AS MATERIALIZED ({inner}) SELECT {_COLS}, {_KEY} AS hk FROM m JOIN span s ON s.unit_rid=m.rid "
               f"JOIN unit u ON u.rid=m.rid WHERE {w} ORDER BY m.rank, s.sid")
        cur = self.con.execute(sql, [*ip, *p])
        cols = [d[0] for d in cur.description]
        for r in cur:
            yield dict(zip(cols, r))

    def _or_expr(self) -> str:
        toks = self.plan.tokens()
        if config.get("lexical.rare_only", False):
            rare = _rare_tokens(self.con, toks)
            if rare:
                toks = rare
        return self.plan.or_expr(toks)

    def _run(self) -> Iterator[dict]:
        seen: set[str] = set()
        a_expr = self.plan.and_expr()
        for r in self._stage(a_expr):
            if r["hk"] not in seen:
                seen.add(r["hk"])
                yield r
        if len(seen) < K_OR:
            o_expr = self._or_expr()
            if o_expr and o_expr != a_expr:
                for r in self._stage(o_expr):
                    if r["hk"] not in seen:
                        seen.add(r["hk"])
                        yield r

    def fill(self, n: int) -> None:
        while not self.done and len(self.buf) < n:
            try:
                self.buf.append(next(self._gen))
            except StopIteration:
                self.done = True

    def total(self) -> int:
        """필터 경로의 정확한 개수. AND가 K_OR 이상이면 AND 개수, 아니면 OR 개수(OR는 AND의 상위 집합)."""
        w, p = _where(self.ctx, self.kinds)

        cand = self._candidates()

        def count(expr: str) -> int:
            inner = "SELECT rowid AS rid FROM fts WHERE fts MATCH ?" + (" AND rowid IN (SELECT value FROM json_each(?))" if cand else "")
            sql = f"WITH m AS MATERIALIZED ({inner}) SELECT COUNT(DISTINCT {_KEY}) FROM m JOIN span s ON s.unit_rid=m.rid WHERE {w}"
            return self.con.execute(sql, [expr, *([cand] if cand else []), *p]).fetchone()[0]

        a_expr = self.plan.and_expr()
        n = count(a_expr)
        if n >= K_OR:
            return n
        o_expr = self._or_expr()
        return count(o_expr) if o_expr and o_expr != a_expr else n


# ------------------------------------------------------------------ 항목 만들기

class _Texts:
    """스냅샷 표시 본문과 문단 표를 한 요청 안에서 한 번만 읽는다."""

    def __init__(self, con):
        self.con = con
        self.snap: dict[str, tuple[str, list, str]] = {}

    def get(self, sid: str) -> tuple[str, list, str]:
        if sid in self.snap:
            return self.snap[sid]
        import json
        text, paras, url = "", [], ""
        r = self.con.execute("SELECT props FROM node WHERE id=? ORDER BY version DESC LIMIT 1", (sid,)).fetchone()
        if r and r[0]:
            try:
                props = json.loads(r[0])
            except (ValueError, TypeError):
                props = {}
            url = props.get("url") or ""
            try:
                if props.get("text_sha"):
                    text = cas.get(props["text_sha"]).decode("utf-8")
                if props.get("paras_sha"):
                    paras = json.loads(cas.get(props["paras_sha"]))
            except (cas.CasError, OSError, ValueError):
                pass
        self.snap[sid] = (text, paras, url)
        return self.snap[sid]


def _nodes(con, ctx: ReadCtx, ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not ids:
        return out
    w, p = visibility_sql(ctx, "n", kind="node", mode="target")
    for i in range(0, len(ids), 400):
        ch = ids[i:i + 400]
        for r in rows(con, f"SELECT n.* FROM node n WHERE n.id IN ({','.join('?' * len(ch))}) AND {w}", [*ch, *p]):
            out.setdefault(r["id"], r)
    return out


def _body(con, content_sha) -> str | None:
    if not content_sha:
        return None
    r = con.execute("SELECT body FROM content WHERE sha=?", (content_sha,)).fetchone()
    return r[0] if r else None


def _items(con, ctx: ReadCtx, hits: list[dict], plan: Plan) -> list[dict]:
    nodes = _nodes(con, ctx, [h["ref_id"] for h in hits if h["ref_kind"] != "document"])
    texts = _Texts(con)
    toks = plan.tokens()
    src_cache: dict[str, dict] = {}

    def src(sid):
        if sid not in src_cache:
            src_cache[sid] = source_ref(con, sid)
        return src_cache[sid]

    out = []
    for h in hits:
        kind = _REF_KIND[h["ref_kind"]]
        base = {"id": h["hk"], "kind": kind, "type": h["type"]}
        if kind == "passage":
            text, paras, url = texts.get(h["snapshot_id"])
            a, b = h["start_cp"], h["end_cp"]
            body = text[a:b] if text else ""
            title = ""
            for pr in paras:
                if pr.get("start_cp") == a:
                    hp = pr.get("heading_path") or []
                    title = hp[-1] if hp else ""
                    break
            base.update(title=title or url, **make_snippet(body, plan.words, toks), highlight_unit="codepoint",
                        origin=h["origin"], status=h["eff_status"], snapshot_id=h["snapshot_id"], start=a, end=b,
                        source=src(h["source_id"]))
            out.append(_order(base))
            continue
        n = nodes.get(h["ref_id"])
        label = (n or {}).get("label") or ""
        text = label
        if kind == "record" and h["ukind"] == "body" and n:
            text = _body(con, n.get("content_sha")) or label
        base.update(title=label, **make_snippet(text, plan.words, toks), highlight_unit="codepoint",
                    origin=h["origin"], status=h["eff_status"])
        rec = iso(n["recorded_at"]) if n else None
        if kind == "claim":
            base.update(subject=h["subject"] or "", source=src(h["source_id"]), verification=h["verification"] or "",
                        recorded_at=rec)
        elif kind == "record":
            base.update(author=(n or {}).get("author"), sensitivity=SENS_NAME.get(h["sensitivity"], "internal"), recorded_at=rec)
        else:
            base.update(liveness=(n or {}).get("liveness"))
        out.append(_order(base))
    return out


_ORDER = ("id", "kind", "type", "title", "snippet", "highlights", "highlight_unit", "origin", "status")


def _order(d: dict) -> dict:
    head = {k: d[k] for k in _ORDER if k in d}
    head.update({k: v for k, v in d.items() if k not in head})
    return head


# ------------------------------------------------------------------ 공개 함수

def _kinds(kinds) -> tuple:
    if kinds is None or kinds == "":
        return KINDS
    ks = [x.strip() for x in kinds.split(",")] if isinstance(kinds, str) else list(kinds)
    ks = [k for k in ks if k]
    for k in ks:
        if k not in KINDS:
            raise BadParam(f"kinds 값 오류: {k!r}", "kinds")
    return tuple(k for k in KINDS if k in ks) or KINDS


def _hybrid_order(q, ctx, kinds, limit):
    """kb.rank.client.search 결과의 id 순서. 모듈이 없거나 None이면 None."""
    try:
        from kb.rank import client
    except ImportError:
        return None
    try:
        r = client.search(q, ctx, kinds=kinds, limit=limit)
    except Exception:
        return None
    if r is None:
        return None
    ids = getattr(r, "ids", r)
    try:
        return [x if isinstance(x, str) else getattr(x, "id") for x in ids]
    except (TypeError, AttributeError):
        return None


def search_in(con, ctx: ReadCtx, q: str, *, mode: str = "lexical", kinds=None, limit=None, cursor=None) -> tuple[dict, dict, list]:
    """(data, page, extra_degraded). con은 reading(ctx)의 연결이다."""
    if mode not in ("lexical", "hybrid"):
        raise BadParam(f"mode 값 오류: {mode!r}", "mode")
    ks = _kinds(kinds)
    lim = clamp_limit(limit, 50, 200)
    plan = build_plan(q, con)
    extra: list[str] = []
    order = None
    if mode == "hybrid":
        order = _hybrid_order(plan.q, ctx, ks, lim)
        if order is None:
            extra.append("lexical_only")
    capped = _is_default(ctx, ks)
    st = _Stream(con, ctx, plan, ks, capped)
    fh = [plan.q, list(ks), "hybrid" if order is not None else "lexical"]
    cur = read_cursor(con, ctx, cursor, fh)
    pos, anchor = (cur[0], cur[1]) if cur else (0, None)
    if order is not None:
        st.fill(HYBRID_POOL)
        rank = {k: i for i, k in enumerate(order)}
        st.buf.sort(key=lambda h: rank.get(h["hk"], len(rank)))  # 안정 정렬: 나머지는 어휘 순서
    start = pos
    if anchor is not None:
        st.fill(max(pos, 1) + 1)
        if not (0 < pos <= len(st.buf) and st.buf[pos - 1]["hk"] == anchor):
            st.fill(ANCHOR_SCAN)
            for i, h in enumerate(st.buf[:ANCHOR_SCAN]):
                if h["hk"] == anchor:
                    start = i + 1
                    break
    st.fill(start + lim + 1)
    chunk = st.buf[start:start + lim]
    more = len(st.buf) > start + lim
    nxt = make_cursor(con, ctx, k=[start + lim, chunk[-1]["hk"]], fh_parts=fh) if more and chunk else None
    total = None if capped else st.total()
    truncated = bool(capped and st.hit_cap and not more)
    return {"items": _items(con, ctx, chunk, plan)}, page_obj(nxt, total, truncated), extra


def search(q: str, ctx: ReadCtx, *, mode: str = "lexical", kinds=None, limit=None, cursor=None) -> dict:
    """/v1/search. 봉투(계약 2.1) 전체를 돌려준다."""
    with reading(ctx) as con:
        data, page, extra = search_in(con, ctx, q, mode=mode, kinds=kinds, limit=limit, cursor=cursor)
        return envelope(con, ctx, data, page=page, extra_degraded=extra)


def search_facets(q: str, ctx: ReadCtx, *, kinds=None, filter=None) -> dict:
    """/v1/facets?q=. 후보는 패싯 필터를 걸기 전의 전체 일치다. 각 축은 WP-04 facets가 자기 축 필터만 빼고 센다."""
    ks = _kinds(kinds)
    with reading(ctx) as con:
        plan = build_plan(q, con)
        wide = ctx.with_(types=None, exclude_types=(), origin=None, domains=None, sources=None, authors=None, status="all")
        st = _Stream(con, wide, plan, tuple(k for k in ks if k != "passage") or ("entity",), False)
        st.fill(10 ** 9)
        ids = sorted({h["ref_id"] for h in st.buf})
        data = _facets(con, ctx, filter=filter, restrict_ids=ids)
        return envelope(con, ctx, data)


def promote_passage(con, ctx: ReadCtx, hit: dict) -> list[str]:
    """passage 히트가 덮는 주장 id(활성, 보이는 것). 문단이 이기면 그 문단의 주장으로 승격하는 데 쓴다(WP-20)."""
    if hit.get("kind") != "passage":
        return []
    w, p = visibility_sql(ctx, "n")
    rr = rows(con, f"SELECT DISTINCT n.id FROM evidence e JOIN node n ON n.id=e.claim_id WHERE e.snapshot_id=? AND "
                   f"e.start_cp IS NOT NULL AND e.start_cp < ? AND e.end_cp > ? AND n.type='Claim' AND {w} ORDER BY n.id",
              [hit["snapshot_id"], hit["end"], hit["start"], *p])
    return [r["id"] for r in rr]
