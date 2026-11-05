"""읽기 문맥과 가시성 필터(WP-04). 민감도, 상태, 검증, as-of, 목록 필터는 전부 visibility_sql 한 함수가 만든다.

다른 모듈은 필터 SQL을 쓰지 않는다. 이 파일만 head 표와 시간축 열을 조건으로 쓴다.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

from kb.core import conn as _conn

SENS = {"public": 0, "internal": 1, "private": 2, "secret": 3}
SENS_NAME = {v: k for k, v in SENS.items()}
STATUSES = ("active", "superseded", "dead")
OK_VERIFICATION = ("quote_found", "parser_derived", "first_party")
ALL_VERIFICATION = OK_VERIFICATION + ("needs_review", "unverified")
NEIGHBOR_EXCLUDED = ("Claim", "Snapshot", "Source", "Document", "Ticket")
NEG_INF = -9e18


# ------------------------------------------------------------------ 오류

class ReadError(Exception):
    status = 500
    code = "internal"
    param: str | None = None

    def __init__(self, detail: str = "", param: str | None = None):
        super().__init__(detail or self.code)
        self.detail = detail or self.code
        if param is not None:
            self.param = param


class NotFound(ReadError):
    status, code = 404, "not_found"


class BadParam(ReadError):
    status, code = 400, "bad_param"


class ScopeDenied(ReadError):
    status, code = 403, "scope_denied"


class LimitTooLarge(ReadError):
    status, code = 400, "limit_too_large"


class CursorMismatch(ReadError):
    status, code = 400, "cursor_mismatch"


class AsOfUnsupported(ReadError):
    status, code = 400, "as_of_unsupported"


class EpochChanged(ReadError):
    status, code = 410, "epoch_changed"


class ContentRemoved(ReadError):
    status, code = 410, "content_removed"


class ReadTimeout(ReadError):
    status, code = 503, "read_timeout"


class NotReady(ReadError):
    status, code = 503, "not_ready"


# ------------------------------------------------------------------ 시각

def iso(ms: int | None) -> str | None:
    """UTC ms -> RFC 3339. 밀리초가 0이 아니면 3자리."""
    if ms is None:
        return None
    dt = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    frac = ms % 1000
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + (f".{frac:03d}" if frac else "") + "Z"


def parse_ts(s, param: str = "as_of") -> int | None:
    """RFC 3339 또는 YYYY-MM-DD(그날 00:00Z) -> UTC ms. 정수는 ms로 본다."""
    if s is None or s == "":
        return None
    if isinstance(s, int) and not isinstance(s, bool):
        return s
    t = str(s).strip()
    try:
        if len(t) == 10:
            dt = datetime.strptime(t, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(t.replace("z", "Z"))
            if dt.tzinfo is None:
                raise ValueError("시간대 없음")
        return int(round(dt.timestamp() * 1000))
    except ValueError as e:
        raise BadParam(f"시각 형식 오류: {s!r}", param) from e


def _csv(v) -> tuple | None:
    if v is None or v == "" or v == ():
        return None
    if isinstance(v, str):
        out = tuple(x.strip() for x in v.split(",") if x.strip())
    else:
        out = tuple(v)
    return out or None


# ------------------------------------------------------------------ 문맥

@dataclass(frozen=True)
class ReadCtx:
    max_sensitivity: str | int = "internal"
    as_of_valid: int | None = None
    as_of_observed: int | None = None
    status: str = "active"
    include_unverified: bool = False
    deadline_s: float = 5.0
    # 목록 필터(공통 필터 F). 모두 visibility_sql을 지난다.
    types: tuple | None = None
    exclude_types: tuple = ()
    origin: tuple | None = None
    domains: tuple | None = None
    sources: tuple | None = None
    authors: tuple | None = None
    edge_status: tuple | None = None
    db_path: str | None = None
    trash_ids: tuple | None = None

    @property
    def max_sens(self) -> int:
        m = self.max_sensitivity
        if isinstance(m, int):
            return m
        if m not in SENS:
            raise BadParam(f"민감도 값 오류: {m!r}", "max_sensitivity")
        return SENS[m]

    def with_(self, **kw) -> "ReadCtx":
        return replace(self, **kw)

    @classmethod
    def build(cls, *, status: str = "active", as_of_valid=None, as_of_observed=None, types=None, origin=None,
              domain=None, source=None, author=None, edge_status=None, include_unverified=False,
              max_sensitivity="internal", deadline_s: float = 5.0, exclude_types=(), db_path=None, trash_ids=None) -> "ReadCtx":
        """문자열 파라미터(쉼표 목록, 시각)를 검증해 문맥을 만든다. 오류는 BadParam."""
        if status not in STATUSES + ("all",):
            raise BadParam(f"status 값 오류: {status!r}", "status")
        es = _csv(edge_status)
        for v in es or ():
            if v not in STATUSES + ("all",):
                raise BadParam(f"edge_status 값 오류: {v!r}", "edge_status")
        og = _csv(origin)
        for v in og or ():
            if v not in ("external", "first_party"):
                raise BadParam(f"origin 값 오류: {v!r}", "origin")
        if isinstance(include_unverified, str):
            include_unverified = include_unverified.lower() in ("1", "true", "yes")
        return cls(max_sensitivity=max_sensitivity, as_of_valid=parse_ts(as_of_valid, "as_of_valid"),
                   as_of_observed=parse_ts(as_of_observed, "as_of_observed"), status=status,
                   include_unverified=bool(include_unverified), deadline_s=deadline_s, types=_csv(types),
                   exclude_types=tuple(exclude_types), origin=og, domains=_csv(domain), sources=_csv(source),
                   authors=_csv(author), edge_status=es, db_path=str(db_path) if db_path else None, trash_ids=trash_ids)

    def verification_ok(self) -> tuple:
        return ALL_VERIFICATION if self.include_unverified else OK_VERIFICATION

    def edge_statuses(self) -> tuple:
        return self.edge_status if self.edge_status is not None else (self.status,)


def _in(col: str, vals: tuple, params: list) -> str:
    params.extend(vals)
    return f"{col} IN ({','.join('?' * len(vals))})"


def _domain_sql(id_col: str, doms: tuple, params: list) -> str:
    parts = []
    named = tuple(d for d in doms if d != "none")
    if named:
        params.extend(named)
        parts.append(f"EXISTS(SELECT 1 FROM node_domain d WHERE d.node_id={id_col} AND d.domain IN ({','.join('?' * len(named))}))")
    if "none" in doms:
        parts.append(f"NOT EXISTS(SELECT 1 FROM node_domain d WHERE d.node_id={id_col})")
    return "(" + " OR ".join(parts) + ")"


def visibility_sql(ctx: ReadCtx, a: str = "n", *, kind: str = "node", mode: str = "list") -> tuple[str, list]:
    """(SQL 조각, 파라미터). 별칭 a의 행에 걸 조건이다.

    kind: node | edge | span | series_obs | change.
    mode: list(모든 필터) | direct(민감도 + 두 시간축, id 직접 조회) | target(민감도 + 관측축, 상세의 대상)
          | history(민감도 + 검증, 시간축과 상태 없음) | versions(민감도만, 한 ID의 전 버전).
    민감도는 ID별 최신 값(head.sensitivity)으로 판단한다. 현재 행만 보는 조회는 행의 값이 곧 그 값이라 head를 읽지 않는다
    (투영이 새 버전과 head, 엣지 전파와 head를 같은 트랜잭션에서 함께 쓴다. tests/http/test_node_fact.py가 대조한다).
    """
    S = ctx.max_sens
    w: list[str] = []
    p: list = []
    if kind == "change":
        w.append(f"{a}.sensitivity <= ?")
        p.append(S)
        w.append(f"(COALESCE((SELECT h.sensitivity FROM head h WHERE h.id={a}.id),0) <= ? OR {a}.kind='visibility.revoked')")
        p.append(S)
        return " AND ".join(w), p
    idc = {"node": f"{a}.id", "edge": f"{a}.id", "span": f"{a}.ref_id", "series_obs": f"{a}.series_id"}[kind]
    if kind in ("node", "edge") and mode in ("list", "direct", "target") and ctx.as_of_observed is None:
        w.append(f"{a}.sensitivity <= ?")   # 아래에서 현재 행(expired_at IS NULL)으로 좁힌다. 현재 행의 민감도는 head 값과 같다
    else:
        w.append(f"(SELECT h.sensitivity FROM head h WHERE h.id={idc}) <= ?")
    p.append(S)
    if kind == "node":
        w.append(f"({a}.type<>'Claim' OR COALESCE((SELECT h2.sensitivity FROM head h2 WHERE h2.id="
                 f"(SELECT c.subject FROM claim c WHERE c.vid={a}.vid)),0) <= ?)")
        p.append(S)
    o, v = ctx.as_of_observed, ctx.as_of_valid
    use_obs = mode in ("list", "direct", "target")
    use_val = mode in ("list", "direct") and v is not None
    if use_obs:
        if kind == "span":
            w.append(f"{a}.rec_to IS NULL" if o is None else f"({a}.rec_from <= ? AND ({a}.rec_to IS NULL OR {a}.rec_to > ?))")
        elif kind == "series_obs":
            w.append(f"{a}.expired_at IS NULL" if o is None else f"({a}.observed_at <= ? AND ({a}.expired_at IS NULL OR {a}.expired_at > ?))")
        else:
            w.append(f"{a}.expired_at IS NULL" if o is None else f"({a}.recorded_at <= ? AND ({a}.expired_at IS NULL OR {a}.expired_at > ?))")
        if o is not None:
            p += [o, o]
    if use_val:
        if kind == "span":
            w.append(f"(({a}.ref_kind='document' AND {a}.rec_from <= ? AND ({a}.rec_to IS NULL OR {a}.rec_to > ?)) OR "
                     f"({a}.ref_kind<>'document' AND COALESCE({a}.valid_from,{NEG_INF!r}) <= ? AND ({a}.valid_to IS NULL OR {a}.valid_to > ?)))")
            p += [v, v, v, v]
        elif kind == "series_obs":
            w.append(f"({a}.period_start <= ? AND ({a}.period_end IS NULL OR {a}.period_end > ?))")
            p += [v, v]
        else:
            w.append(f"(COALESCE({a}.valid_from,{NEG_INF!r}) <= ? AND ({a}.valid_to IS NULL OR {a}.valid_to > ?))")
            p += [v, v]
    ver = ctx.verification_ok()
    if mode in ("list", "history"):
        if kind == "node":
            w.append(f"({a}.type<>'Claim' OR {_in(a + '.verification', ver, p)})")
        elif kind == "span":
            w.append(f"({a}.ref_kind<>'claim' OR {_in(a + '.verification', ver, p)})")
        elif kind == "edge":
            p.extend(ver)
            w.append(f"({a}.claim_id IS NULL OR EXISTS(SELECT 1 FROM node cn WHERE cn.id={a}.claim_id AND cn.expired_at IS NULL "
                     f"AND cn.verification IN ({','.join('?' * len(ver))})))")
    if mode != "list":
        return " AND ".join(w), p
    if kind == "node":
        if ctx.trash_ids is not None:
            if ctx.trash_ids:
                w.append(_in(f"{a}.id", ctx.trash_ids, p))
            else:
                w.append("0")
        if ctx.status != "all":
            w.append(f"{a}.eff_status = ?")
            p.append(ctx.status)
        w.append(f"{a}.merged_into IS NULL")
        if ctx.types:
            w.append(_in(f"{a}.type", ctx.types, p))
        if ctx.exclude_types:
            w.append("NOT " + _in(f"{a}.type", ctx.exclude_types, p))
        if ctx.origin:
            w.append(_in(f"{a}.origin", ctx.origin, p))
        if ctx.authors:
            w.append(_in(f"{a}.author", ctx.authors, p))
        if ctx.sources:
            ph = ",".join("?" * len(ctx.sources))
            w.append(f"(EXISTS(SELECT 1 FROM span s WHERE s.ref_id={a}.id AND s.rec_to IS NULL AND s.source_id IN ({ph})) "
                     f"OR json_extract(CAST({a}.props AS TEXT),'$.source') IN ({ph}))")
            p += list(ctx.sources) * 2
        if ctx.domains:
            w.append(_domain_sql(f"{a}.id", ctx.domains, p))
    elif kind == "edge":
        es = ctx.edge_statuses()
        if "all" not in es:
            w.append(_in(f"{a}.status", es, p))
    elif kind == "span":
        if ctx.status != "all":
            w.append(f"{a}.eff_status = ?")
            p.append(ctx.status)
        w.append(f"NOT EXISTS(SELECT 1 FROM head hm WHERE hm.id={a}.ref_id AND hm.merged_into_final IS NOT NULL)")
        if ctx.types:
            w.append(_in(f"{a}.type", ctx.types, p))
        if ctx.exclude_types:
            w.append("NOT " + _in(f"{a}.type", ctx.exclude_types, p))
        if ctx.origin:
            w.append(_in(f"{a}.origin", ctx.origin, p))
        if ctx.sources:
            w.append(_in(f"{a}.source_id", ctx.sources, p))
        if ctx.authors:
            w.append(f"EXISTS(SELECT 1 FROM node an WHERE an.id={a}.ref_id AND an.expired_at IS NULL AND " + _in("an.author", ctx.authors, p) + ")")
        if ctx.domains:
            w.append(_domain_sql(f"{a}.ref_id", ctx.domains, p))
    return " AND ".join(w), p


def fact_groups(con, ctx: ReadCtx, *, match_sources: bool = False) -> list[dict] | None:
    """node_fact(주장 밖 현재 노드 요약)를 축 값으로 묶는다. 행마다 type, origin, eff_status, src, dom, c다.
    민감도만 여기서 걸고 나머지 축은 호출자가 묶음 키로 거른다. match_sources면 소스 필터를 지난 노드만 센다.
    표가 없으면(gold_schema 3 이전 빌드) None이다."""
    if row(con, "SELECT 1 x FROM sqlite_master WHERE name='node_fact'") is None:
        return None
    w, p = "f.sensitivity <= ?", [ctx.max_sens]
    if match_sources:
        ph = ",".join("?" * len(ctx.sources))
        w += f" AND (f.id IN (SELECT s.ref_id FROM span s WHERE s.rec_to IS NULL AND s.source_id IN ({ph})) OR f.psrc IN ({ph}))"
        p += list(ctx.sources) * 2
    return rows(con, f"SELECT f.type, f.origin, f.eff_status, f.src, f.dom, COUNT(*) AS c FROM node_fact f WHERE {w} GROUP BY 1,2,3,4,5", p)


def touching_sql(ctx: ReadCtx, ids_, direction: str = "both", a: str = "e") -> tuple[str, list]:
    """ids_에 닿는 엣지 조건 하나. OR 대신 UNION 부분 질의로 만들어 edge_src, edge_dst 색인을 탄다
    (색인은 expired_at IS NULL 부분 색인이라 현재 읽기에서만 쓴다)."""
    ids_ = list(ids_)
    cur = "" if ctx.as_of_observed is not None else " AND expired_at IS NULL"
    ph = ",".join("?" * len(ids_))
    parts = []
    if direction in ("out", "both"):
        parts.append(f"SELECT vid FROM edge WHERE src IN ({ph}){cur}")
    if direction in ("in", "both"):
        parts.append(f"SELECT vid FROM edge WHERE dst IN ({ph}){cur}")
    return f"{a}.vid IN ({' UNION '.join(parts)})", ids_ * len(parts)


# ------------------------------------------------------------------ 연결

def gold_path(ctx: ReadCtx) -> Path:
    if ctx.db_path:
        return Path(ctx.db_path)
    from kb.project import current_gold_path
    p = current_gold_path()
    if p is None:
        raise NotReady("graph.db가 아직 없음")
    return p


@contextmanager
def reading(ctx: ReadCtx):
    """요청 하나의 읽기 연결. 읽기 트랜잭션 1개 안에서 봉투와 본문을 만든다."""
    con = _conn.connect_ro(gold_path(ctx), ctx.deadline_s)
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN")
        yield con
    except sqlite3.OperationalError as e:
        if "interrupt" in str(e).lower():
            raise ReadTimeout("읽기 시간 초과") from e
        raise
    finally:
        con.close()


def rows(con: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in tuples(con, sql, params, sqlite3.Row)]


def tuples(con: sqlite3.Connection, sql: str, params=(), factory=None) -> list:
    """행을 튜플로 읽는다(큰 결과용). 읽기 시간 초과는 ReadTimeout이다."""
    try:
        cur = con.execute(sql, params)
        cur.row_factory = factory
        return cur.fetchall()
    except sqlite3.OperationalError as e:
        if "interrupt" in str(e).lower():
            raise ReadTimeout("읽기 시간 초과") from e
        raise


def row(con: sqlite3.Connection, sql: str, params=()) -> dict | None:
    r = rows(con, sql, params)
    return r[0] if r else None


def chunks(seq, n: int = 500):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ------------------------------------------------------------------ head 조회(병합 묶음)

def head_of(con, nid: str) -> dict | None:
    return row(con, "SELECT id, kind, version, sensitivity, merged_into_final FROM head WHERE id=?", (nid,))


def final_of(con, nid: str) -> str:
    h = head_of(con, nid)
    return (h or {}).get("merged_into_final") or nid


def finals(con) -> dict[str, str]:
    """병합된 ID -> 최종 대상. 병합이 없으면 비어 있다."""
    return {r["id"]: r["merged_into_final"] for r in rows(con, "SELECT id, merged_into_final FROM head WHERE merged_into_final IS NOT NULL")}


def group_of(con, nid: str) -> list[str]:
    """nid와, 연쇄 병합으로 nid 아래에 묶이는 ID 전부. nid가 병합됐으면 nid만."""
    out = [nid]
    out += [r["id"] for r in rows(con, "SELECT id FROM head WHERE merged_into_final=? ORDER BY id", (nid,))]
    return out


def sens_ok(ctx: ReadCtx, h: dict | None) -> bool:
    return h is not None and h["sensitivity"] <= ctx.max_sens
