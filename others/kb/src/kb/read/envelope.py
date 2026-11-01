"""계약 2.1 봉투, 커서, 저하 표시(WP-04). 표준 라이브러리만 쓴다."""
from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import time

from kb.read.ctx import (BadParam, CursorMismatch, EpochChanged, ReadCtx, iso, reading, row, rows)

SCHEMA_VERSION = "0.3.1"
CONTRACT = "v1"
STALE_GRACE_S = 60


def gold_meta(con) -> dict:
    return {r["k"]: r["v"] for r in rows(con, "SELECT k, v FROM meta")}


def applied_seq(con) -> int:
    return int(gold_meta(con).get("applied_seq") or 0)


def epoch_of(con) -> int:
    """gold meta.epoch은 0에서 시작하고 복원마다 오른다. 계약 epoch은 1 이상이라 1을 더한다."""
    return int(gold_meta(con).get("epoch") or 0) + 1


def data_as_of(con, seq: int) -> int | None:
    if seq <= 0:
        return None
    r = row(con, "SELECT at FROM change WHERE seq<=? ORDER BY seq DESC, sub ASC LIMIT 1", (seq,))
    return r["at"] if r else None


# ------------------------------------------------------------------ 커서

def encode_cursor(d: dict) -> str:
    raw = json.dumps(d, separators=(",", ":"), ensure_ascii=False, sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(s: str) -> dict:
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        d = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise CursorMismatch("해석할 수 없는 커서") from e
    if not isinstance(d, dict):
        raise CursorMismatch("해석할 수 없는 커서")
    return d


def filter_hash(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()[:8]


def ctx_key(ctx: ReadCtx) -> list:
    """커서의 필터 해시에 들어가는 문맥 값. 같은 요청이면 같고 다른 필터면 다르다."""
    return [ctx.status, ctx.include_unverified, ctx.as_of_valid, ctx.as_of_observed, ctx.types, ctx.exclude_types,
            ctx.origin, ctx.domains, ctx.sources, ctx.authors, ctx.edge_status, ctx.max_sens]


def make_cursor(con, ctx: ReadCtx, *, k, fh_parts) -> str:
    return encode_cursor({"e": epoch_of(con), "k": k, "f": filter_hash(ctx_key(ctx), fh_parts)})


def read_cursor(con, ctx: ReadCtx, cursor: str | None, fh_parts):
    """커서를 풀어 정렬 키를 돌려준다. 없으면 None. 필터가 다르면 CursorMismatch, epoch이 다르면 EpochChanged."""
    if not cursor:
        return None
    d = decode_cursor(cursor)
    if "e" not in d or "f" not in d or "k" not in d:
        raise CursorMismatch("해석할 수 없는 커서")
    if d["e"] != epoch_of(con):
        raise EpochChanged("커서의 epoch이 현재와 다르다")
    if d["f"] != filter_hash(ctx_key(ctx), fh_parts):
        raise CursorMismatch("cursor는 다른 필터로 만들어졌다")
    return d["k"]


def changes_cursor(con) -> str:
    return encode_cursor({"e": epoch_of(con), "s": applied_seq(con)})


def clamp_limit(limit, default: int, maximum: int, param: str = "limit") -> int:
    if limit is None:
        return default
    try:
        n = int(limit)
    except (TypeError, ValueError) as e:
        raise BadParam(f"limit 형식 오류: {limit!r}", param) from e
    if n < 1:
        raise BadParam("limit은 1 이상", param)
    if n > maximum:
        from kb.read.ctx import LimitTooLarge
        raise LimitTooLarge(f"{param} 상한 {maximum}", param)
    return n


# ------------------------------------------------------------------ 저하 표시

def degraded(*, extra=()) -> list[str]:
    """ops.db의 안내(boot_path_unverified)와 stale_build(원장 머리가 applied_seq보다 앞선 채 지속)."""
    out: list[str] = list(extra)
    try:
        from kb.core import opsdb
        p = opsdb.ops_path()
        if p.exists():
            c = sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
            try:
                ts = {k: v for k, v in c.execute("SELECT k, v FROM tick_state")}
            finally:
                c.close()
            if ts.get("boot_path_unverified") in ("1", "true"):
                out.append("boot_path_unverified")
            if ts.get("stale_build") in ("1", "true"):
                out.append("stale_build")
            elif ts.get("ledger_head_seq") and ts.get("behind_since_ms"):
                out.append(("stale_build", int(ts["ledger_head_seq"]), int(ts["behind_since_ms"])))  # type: ignore[arg-type]
    except (sqlite3.Error, OSError, ValueError, ImportError):
        pass
    return out


def _resolve_degraded(items, seq: int) -> list[str]:
    res: list[str] = []
    now = int(time.time() * 1000)
    for it in items:
        if isinstance(it, tuple):
            _, head, since = it
            if head > seq and now - since > STALE_GRACE_S * 1000 and "stale_build" not in res:
                res.append("stale_build")
        elif it not in res:
            res.append(it)
    return res


# ------------------------------------------------------------------ 봉투

def envelope(con, ctx: ReadCtx, data, *, page: dict | None = None, extra_degraded=()) -> dict:
    gm = gold_meta(con)
    seq = int(gm.get("applied_seq") or 0)
    env = {
        "schema_version": SCHEMA_VERSION,
        "epoch": int(gm.get("epoch") or 0) + 1,
        "build_id": gm.get("build_id") or "",
        "data_as_of": iso(data_as_of(con, seq)),
        "applied_seq": seq,
        "as_of": {"valid": iso(ctx.as_of_valid), "observed": iso(ctx.as_of_observed)},
        "degraded": _resolve_degraded(degraded(extra=extra_degraded), seq),
        "data": data,
    }
    if page is not None:
        env["page"] = page
    return env


def page_obj(next_cursor, total, truncated) -> dict:
    return {"next_cursor": next_cursor, "total": total, "truncated": bool(truncated)}


def etag(env: dict) -> str:
    return f'"{env["epoch"]}-{env["applied_seq"]}-{env["build_id"]}"'


def read(ctx: ReadCtx, fn, *args, **kw) -> dict:
    """읽기 연결 하나, 트랜잭션 하나로 fn(con, ctx, ...)을 돌리고 봉투를 씌운다.
    fn은 data 또는 (data, page)를 돌려준다."""
    with reading(ctx) as con:
        out = fn(con, ctx, *args, **kw)
        if isinstance(out, tuple):
            return envelope(con, ctx, out[0], page=out[1])
        return envelope(con, ctx, out)
