"""자동 API 호출의 공통 예약·정산과 KST 일일 밸브(ADR-0004 E1).
기존 tick_state/metric 장부를 사용한다. OpenRouter 잔액은 내부 장부가 기준이며 /credits는 대조용이다."""
from __future__ import annotations

import datetime as _dt
import math
import json
import uuid
import sqlite3
from contextlib import contextmanager
from collections.abc import Mapping
from types import MappingProxyType

from kb.core import opsdb

from kb.extract import settings, state

BAL = "llm:or:balance"
DEFAULT_PRICE = 0.032337          # [실측] Sol 19창 평균
ORDER = ("extract", "support", "cross")   # 소진 순서: 추출 큐 -> 함의 판정 -> 교차 확인 확대


def day_key(day: str | None = None) -> str:
    return "llm:day:" + (day or settings.kst_day())


def day(day_s: str | None = None) -> dict:
    d = state.get(day_key(day_s)) or {}
    d.setdefault("spent", 0.0)
    d.setdefault("reserved", 0.0)
    d.setdefault("windows", {})
    d.setdefault("support", {})
    d.setdefault("valve_hits", 0)
    d.setdefault("openrouter_windows", 0)
    return d


def _save_day(d: dict, day_s: str | None = None) -> None:
    state.put(day_key(day_s), d)


# ------------------------------------------------------------------ 잔액
def balance() -> float | None:
    b = state.get(BAL)
    return None if b is None else float(b["usd"])


def set_balance(usd: float, source: str = "credits") -> None:
    with _transaction() as c:
        _put(c, BAL, {"usd": round(_money(usd), 6), "at": settings.now_s(), "source": source})


def key_days_left(now_s: float | None = None) -> float | None:
    exp = settings.get("openrouter.key_expires_at")
    if not exp:
        return None
    t = _dt.datetime.fromisoformat(str(exp)).timestamp()
    return round(max(0.0, (t - (now_s if now_s is not None else settings.now_s())) / 86400.0), 2)


def spend_7d(now_s: float | None = None) -> tuple:
    """(7일 평균 일 지출, OpenRouter 추출 평균 단가 | None)."""
    now = now_s if now_s is not None else settings.now_s()
    tot, wins, dollars = 0.0, 0, 0.0
    for i in range(7):
        d = day(settings.kst_day(now - 86400 * i))
        tot += d["spent"]
        wins += d.get("openrouter_windows", 0)
        dollars += d.get("openrouter_extract_usd", 0.0)
    return tot / 7.0, (dollars / wins if wins else None)


def avg_price() -> float:
    return spend_7d()[1] or DEFAULT_PRICE


def daily_window_cap(now_s: float | None = None) -> int:
    """일일 창 수 = max(400, 잔액 / 남은 일수 / 7일 평균 단가). 위쪽은 일일 밸브가 막는다."""
    floor = int(settings.get("claude.daily_windows", 400))
    b, left = balance(), key_days_left(now_s)
    if b is None or not left:
        return floor
    want = math.floor(b / max(left, 1.0) / avg_price())
    return max(floor, want)


def llm_block() -> dict:
    """kb status --json의 llm 블록. 키 파일이 없거나 계산이 실패하면 값은 null이고 네 키는 항상 있다."""
    nul = {"balance_usd": None, "spend_7d_avg_usd": None, "projected_underspend_usd": None, "key_days_left": None}
    try:
        with state.readonly():
            return _llm_block(nul)
    except Exception:  # noqa: BLE001 llm 계산 실패가 kb status를 막지 않는다
        return nul


def _llm_block(nul: dict) -> dict:
    try:
        b = balance()
        if b is None:
            return nul
        avg, _ = spend_7d()
        left = key_days_left()
        under = None if left is None else round(max(0.0, b - avg * left), 4)
        return {"balance_usd": round(b, 4), "spend_7d_avg_usd": round(avg, 4), "projected_underspend_usd": under,
                "key_days_left": left}
    except Exception:  # noqa: BLE001 llm 계산 실패가 kb status를 막지 않는다
        return nul


# ------------------------------------------------------------------ 예약과 정산
class TooLarge(Exception):
    """요청의 입력 토큰 상한이 설정 상한을 넘는다. 보내지 않는다."""


def price_bound(model: str, input_tokens: int, output_tokens: int) -> float:
    """입력과 출력 토큰 상한에 모델 가격(백만 토큰당)을 곱한 호출당 비용 상한. 가격표에 없는 모델은 표의 최고가로 본다."""
    table = settings.get("openrouter.price_per_m") or {}
    pr = table.get(model)
    if not pr:
        pr = [max((v[0] for v in table.values()), default=5.0), max((v[1] for v in table.values()), default=25.0)]
    usd = (input_tokens * float(pr[0]) + output_tokens * float(pr[1])) / 1e6 * float(settings.get("openrouter.reserve_margin", 1.10))
    return math.ceil(usd * 1e6) / 1e6


def reservation_for(be, job) -> float:
    """호출 전 예약액. 어댑터가 요청의 토큰 상한을 알면 거기서 구하고, 모르면 설정의 바닥값이다. 너무 큰 요청은 TooLarge."""
    f = getattr(be, "reservation_usd", None)
    if f is None:
        return float(settings.get("openrouter.reserve_usd", 0.054))
    return f(job)


class Refused(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@contextmanager
def _transaction():
    c = None
    try:
        c = opsdb.connect()
        c.execute("BEGIN IMMEDIATE")
        yield c
        c.commit()
    except (sqlite3.Error, OSError):
        if c is not None:
            c.rollback()
        raise Refused('ledger_unreadable') from None
    except BaseException:
        if c is not None:
            c.rollback()
        raise
    finally:
        if c is not None:
            c.close()


def _get(c, key, default=None):
    r = c.execute("SELECT v FROM tick_state WHERE k=?", (key,)).fetchone()
    if not r:
        return default
    try:
        return json.loads(r[0])
    except (TypeError, ValueError):
        raise Refused("ledger_invalid") from None


def _put(c, key, value):
    c.execute("INSERT INTO tick_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
              (key, json.dumps(value, sort_keys=True)))


def _day(c, key):
    d = _get(c, key, {})
    if not isinstance(d, dict):
        raise Refused("ledger_invalid")
    for k, v in dict(spent=0., reserved=0., windows={}, support={}, valve_hits=0, openrouter_windows=0).items():
        d.setdefault(k, v)
    return d


def _money(value):
    if isinstance(value, bool):
        raise Refused("ledger_invalid")
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise Refused("ledger_missing") from None
    if not math.isfinite(n) or n < 0:
        raise Refused("ledger_invalid")
    return n


def _pending(c):
    """Canonical unresolved rows, plus untracked reservations from legacy daily indexes."""
    totals = {e: 0. for e in ("openrouter", "openai_api", "anthropic_api")}
    indexed = {}
    for key, raw in c.execute("SELECT k,v FROM tick_state WHERE k LIKE 'llm:reservation:%'"):
        try:
            r = json.loads(raw)
            if r['engine'] not in totals or not isinstance(r['day'], str) or r['id'] != key.removeprefix('llm:reservation:'):
                raise ValueError()
            amount = _money(r['usd'])
            totals[r['engine']] += amount
            indexed[r['day']] = indexed.get(r['day'], 0.) + amount
        except (KeyError, TypeError, ValueError):
            raise Refused('reservation_ledger_invalid') from None
    for key, raw in c.execute("SELECT k,v FROM tick_state WHERE k LIKE 'llm:day:%'"):
        try:
            d = json.loads(raw)
            # Pre-E1 daily reservations had no durable ID and belonged to OpenRouter.
            excess = max(0., _money(d.get('reserved', 0)) - indexed.get(key.removeprefix('llm:day:'), 0.))
            totals['openrouter'] += excess
        except (TypeError, ValueError, AttributeError):
            raise Refused('reservation_ledger_invalid') from None
    for engine in totals:
        credit = _get(c, 'credit:' + engine)
        if credit is not None:
            if not isinstance(credit, dict) or 'reserved' not in credit:
                raise Refused('ledger_missing')
            totals[engine] = max(totals[engine], _money(credit['reserved']))
    return totals


def _check(c, engine, usd, day_s=None, *, exclude=None):
    if engine not in {"openrouter", "openai_api", "anthropic_api"}:
        raise Refused("engine")
    amount = _money(usd)
    d = _day(c, day_key(day_s))
    outstanding = _pending(c)
    if exclude:
        outstanding[engine] = max(0., outstanding[engine] - _money(exclude['usd']))
    total_pending = sum(outstanding.values()) + amount
    spent = _money(d['spent'])
    valve = _money(settings.get("openrouter.daily_valve_usd"))
    if spent + total_pending > valve + 1e-9 or (amount == 0 and spent + total_pending >= valve):
        raise Refused("valve")
    credit = _get(c, "credit:" + engine)
    if engine == "openrouter":
        bal = _get(c, BAL)
        if not isinstance(bal, dict):
            raise Refused("ledger_missing")
        if _money(bal.get('usd')) - outstanding[engine] - amount < float(settings.get('openrouter.min_balance_usd', .10)):
            raise Refused('balance')
    elif not isinstance(credit, dict):
        raise Refused('ledger_missing')
    pending = outstanding[engine] + amount
    if credit is not None:
        required = ('balance', 'budget_usd', 'cycle_spent', 'spent_today', 'reserved', 'cap_today')
        if not isinstance(credit, dict) or not all(k in credit for k in required):
            raise Refused('ledger_missing')
        credit.update({k: _money(credit[k]) for k in required})
        # A stale credit index is a hold too, never evidence that rows can be dropped.
        legacy_pending = credit['reserved'] - (_money(exclude['usd']) if exclude else 0.)
        pending = max(outstanding[engine], legacy_pending) + amount
        if pending > credit['balance'] + 1e-9:
            raise Refused('balance')
        for cap, used in (('cap_today','spent_today'), ('budget_usd','cycle_spent'), ('target_today','spent_today')):
            if cap in credit and (credit[used] + pending > _money(credit[cap]) + 1e-9 or
                                  (amount == 0 and credit[used] + pending >= _money(credit[cap]))):
                raise Refused('credit_cap')
    pace = settings.get(f'engines.{engine}.pace', {}) or {}
    if 'cap_day_usd' in pace:
        used = credit['spent_today'] if credit is not None else _money(d.get('spent_by_engine', {}).get(engine, d['spent']))
        if used + pending > _money(pace['cap_day_usd']) + 1e-9:
            raise Refused('credit_cap')
    if 'budget_usd' in pace:
        if credit is None:
            raise Refused('ledger_missing')
        if credit['cycle_spent'] + pending > _money(pace['budget_usd']) + 1e-9:
            raise Refused('credit_cap')
    return d, credit


_ISSUER = object()


class _Admission(Mapping):
    __slots__ = ('_data', '_seal')

    def __init__(self, data, seal):
        if seal is not _ISSUER:
            raise Refused('invalid_admission')
        self._data, self._seal = MappingProxyType(data), seal

    def __getitem__(self, key): return self._data[key]
    def __iter__(self): return iter(self._data)
    def __len__(self): return len(self._data)


def _controls(c, engine, model, role, job):
    from kb.extract import guard, route
    if not isinstance(model, str) or not model.strip():
        raise Refused('model_required')
    if not isinstance(role, str) or not role.strip():
        raise Refused('role_required')
    if engine not in {'openrouter', 'openai_api', 'anthropic_api'}:
        raise Refused('engine')
    if _get(c, route.STOP_KEY) is not None or _get(c, guard.HALT_KEY) is not None:
        raise Refused('engine_held')
    targets = {engine, route.model_key(engine, model), f'{engine}:{model}'}
    if job:
        targets.add('job:' + job)
    for target in targets:
        held = _get(c, route.off_key(target))
        if held is not None:
            if not isinstance(held, dict):
                raise Refused('control_invalid')
            until = held.get('until')
            if until is None or settings.now_s() < float(until):
                raise Refused('engine_held')
    for key in (f'credit:off:{engine}', f'arm:off:{role}:{engine}:{model}', f'job:off:{job}'):
        if _get(c, key) is not None:
            raise Refused('engine_held')
    if not settings.get(f'engines.{engine}.enabled', True) or (engine == 'openrouter' and not settings.get('openrouter.enabled', True)):
        raise Refused('engine_held')
    if settings.get(f'engines.{engine}.pace.mode') == 'off':
        raise Refused('engine_held')
    if route.claude_job_gate(engine=engine, model=model, job=job):
        raise Refused('claude_job_gate')


def admit(engine: str, model: str, role: str, amount: float, *, job: str | None = None):
    """The ONLY reservation issuer. All-date unresolved money and current controls bind every call."""
    if job is None:
        job = role
    if not isinstance(job, str) or not job.strip():
        raise Refused('job_required')
    amount = _money(amount)
    if amount <= 0:
        raise Refused('invalid_reservation')
    amount = math.ceil(amount * 1e6) / 1e6
    with _transaction() as c:
        _controls(c, engine, model, role, job)
        day_s = settings.kst_day()
        d, credit = _check(c, engine, amount, day_s)
        by_engine = d.setdefault('reserved_by_engine', {})
        by_engine[engine] = round(by_engine.get(engine, 0.) + amount, 6)
        d['reserved'] = round(d['reserved'] + amount, 6)
        _put(c, day_key(day_s), d)
        if credit is not None:
            credit['reserved'] = round(credit['reserved'] + amount, 6)
            _put(c, 'credit:' + engine, credit)
        record = dict(id=uuid.uuid4().hex, usd=amount, day=day_s, purpose=role, engine=engine, model=model, job=job)
        _put(c, 'llm:reservation:' + record['id'], dict(record, stage='reserved'))
        return _Admission(record, _ISSUER)


def _record(c, token):
    if not isinstance(token, _Admission) or token._seal is not _ISSUER:
        raise Refused('admission_required')
    stored = _get(c, 'llm:reservation:' + token['id'])
    if not isinstance(stored, dict) or {k:v for k,v in stored.items() if k != 'stage'} != dict(token):
        raise Refused('admission_expired')
    return stored


def before_send(token, *, engine, model, role=None, job=None, consume=True):
    """Re-read controls and ALL outstanding funds at the actual HTTP/CLI boundary."""
    with _transaction() as c:
        stored = _record(c, token)
        if engine != stored['engine'] or model != stored['model'] or (role is not None and role != stored['purpose']) or (job is not None and job != stored['job']):
            raise Refused('admission_mismatch')
        if stored.get('stage') != 'reserved':
            raise Refused('admission_used')
        _controls(c, engine, model, stored['purpose'], stored['job'])
        _check(c, engine, stored['usd'], exclude=stored)
        if consume:
            _put(c, 'llm:reservation:' + stored['id'], dict(stored, stage='sent'))


def check(engine: str, usd: float = 0.) -> None:
    """Read the same ledger used by reservations; missing funding state closes admission."""
    c = opsdb.connect()
    try:
        _check(c, engine, usd)
    finally:
        c.close()


def reserve(usd: float, *, purpose='extract', engine='openrouter', model=None, job=None):
    """Compatibility wrapper; an omitted model is refused, never inferred."""
    return admit(engine, model, purpose, usd, job=job)


def settlement_amount(res: dict, actual: float | None) -> float:
    try:
        return _money(actual) if actual is not None else _money(res["usd"])
    except Refused:
        return _money(res["usd"])


def _complete(res, actual, evidence):
    """Charge the full reservation if cost is missing/invalid; settlement is idempotent."""
    est, act = _money(res["usd"]), settlement_amount(res, actual)
    with _transaction() as c:
        key = "llm:reservation:" + res["id"]
        stored = _get(c, key)
        if stored is None:
            return False
        if {k:v for k,v in stored.items() if k != "stage"} != dict(res):
            raise Refused("reservation_mismatch")
        d = _day(c, day_key(res["day"]))
        d["reserved"] = round(max(0., d["reserved"] - est), 6)
        d["spent"] = round(d["spent"] + act, 6)
        engine = res["engine"]
        spent_by_engine = d.setdefault("spent_by_engine", {})
        spent_by_engine[engine] = round(spent_by_engine.get(engine, 0.) + act, 6)
        by_engine = d.setdefault("reserved_by_engine", {})
        by_engine[engine] = round(max(0., by_engine.get(engine, 0.) - est), 6)
        if engine == "openrouter" and res["purpose"] == "extract":
            d["openrouter_windows"] += 1
            d["openrouter_extract_usd"] = round(d.get("openrouter_extract_usd", 0.) + act, 6)
        _put(c, day_key(res["day"]), d)
        if engine == "openrouter":
            bal = _get(c, BAL)
            if bal is not None:
                _put(c, BAL, dict(usd=round(max(0., float(bal["usd"]) - act), 6), at=settings.now_s(), source="ledger"))
        credit = _get(c, "credit:" + engine)
        if credit is not None:
            credit["reserved"] = round(max(0., credit["reserved"] - est), 6)
            credit["spent_today"] = round(credit["spent_today"] + act, 6)
            credit["cycle_spent"] = round(credit["cycle_spent"] + act, 6)
            credit["balance"] = round(max(0., credit["balance"] - act), 6)
            _put(c, "credit:" + engine, credit)
        _put(c, "llm:reconciled:" + res["id"], dict(stored, actual=act, resolved_at=settings.now_s(), evidence=evidence))
        c.execute("DELETE FROM tick_state WHERE k=?", (key,))
        opsdb.record_metric(c, "llm.spend_usd", act, {"purpose": res["purpose"], "engine": engine})
    return act > est + 1e-9



def settle(res, actual: float | None) -> bool:
    if not isinstance(res, _Admission) or res._seal is not _ISSUER:
        raise Refused('admission_required')
    return _complete(res, actual, 'call_completion')


def release(res: dict) -> None:
    """Release only when the paid process/request never started."""
    with _transaction() as c:
        key = "llm:reservation:" + res["id"]
        stored = _get(c, key)
        if stored is None:
            return
        if not isinstance(res, _Admission) or {k:v for k,v in stored.items() if k != "stage"} != dict(res):
            raise Refused("admission_required")
        if stored.get("stage") != "reserved":
            raise Refused("already_sent")
        d = _day(c, day_key(res["day"]))
        d["reserved"] = round(max(0., d["reserved"] - res["usd"]), 6)
        by_engine = d.setdefault("reserved_by_engine", {})
        by_engine[res["engine"]] = round(max(0., by_engine.get(res["engine"], 0.) - res["usd"]), 6)
        _put(c, day_key(res["day"]), d)
        credit = _get(c, "credit:" + res["engine"])
        if credit is not None:
            credit["reserved"] = round(max(0., credit["reserved"] - res["usd"]), 6)
            _put(c, "credit:" + res["engine"], credit)
        _put(c, 'llm:reconciled:' + res['id'], dict(stored, actual=0., resolved_at=settings.now_s(), evidence='cancelled_before_send'))
        c.execute("DELETE FROM tick_state WHERE k=?", (key,))


def count_window(backend: str, n: int = 1, *, support: bool = False) -> None:
    with _transaction() as c:
        d = _day(c, day_key())
        k = "support" if support else "windows"
        d[k][backend] = d[k].get(backend, 0) + n
        _put(c, day_key(), d)


def windows_today(backend: str, *, support: bool = False) -> int:
    return int(day()["support" if support else "windows"].get(backend, 0))


def spent_today() -> float:
    return day()["spent"]


def exhausted() -> bool:
    b = balance()
    return b is not None and b < float(settings.get("openrouter.min_balance_usd", 0.10))


def reconcile(reservation_id: str, *, actual: float | None, evidence: str):
    """Operator/reconciler only: receipt/evidence required; unknown cost charges the full cap.

    No automatic expiry and no stale-reservation deletion. Legacy unindexed daily holds
    require an explicit ledger audit; they remain counted until that audit is applied.
    """
    if not evidence or not evidence.strip():
        raise Refused('reconciliation_evidence_required')
    with _transaction() as c:
        r = _get(c, 'llm:reservation:' + reservation_id)
    if r is None:
        return False
    data = {k:v for k,v in r.items() if k != 'stage'}
    return _complete(data, actual, evidence)
