"""first_party 입력: put_record, tombstone_record (계약 6.1).

타입이 없으면 Record, 모르는 타입은 provisional로 등록한다. 기존 레코드 갱신에는 expected_version이 필수다.
내용 해시가 같으면 새 버전을 만들지 않는다. 64 KB 넘는 본문은 raw/fp에 넣고 다이제스트만 원장에 둔다.
[[...]]는 LINKS_TO 엣지로 분해한다. 작성자는 서버가 정한다(author.py). 입력 스키마에 author가 없다.
외부 사실(source_url, quote)은 이 창구가 아니라 kb_request 티켓으로 간다(WP-12).
"""
from __future__ import annotations

import base64
import hashlib
import re

from kb.core import ledger
from kb.core.ids import check_public_id
from kb.write import author as _author
from kb.write import secrets_scan, types, validate
from kb.write.engine import WriteResult, commit, hold_name, prior_event
from kb.write.errors import WriteRejected

ALLOWED = frozenset({"id", "type", "title", "body", "body_format", "sensitivity", "retention", "props", "links",
                     "expected_version"})
SENS = ("public", "internal", "private", "secret")
SENS_RANK = {s: i for i, s in enumerate(SENS)}
WIKILINK = re.compile(r"\[\[([^\[\]\n]+?)\]\]")
MAX_KEY = 256


def derive_id(idem_key: str) -> str:
    """새 레코드 ID는 멱등 키에서 결정적으로 만든다. 같은 키의 동시 재시도가 같은 레코드를 가리킨다."""
    d = hashlib.sha256(b"kb-record-id\0" + idem_key.encode()).digest()[:16]
    return "f-" + base64.b32encode(d).decode().lower().rstrip("=")


def wiki_targets(body: str) -> list[str]:
    out = []
    for m in WIKILINK.finditer(body or ""):
        t = m.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if t:
            out.append(t)
    return out


def _check_shape(rec: dict) -> None:
    if not isinstance(rec, dict):
        raise WriteRejected("schema_invalid", "record는 객체여야 한다")
    for k in ("source_url", "quote"):
        if k in rec:
            raise WriteRejected("schema_invalid", f"{k}: 외부 사실은 kb_request의 url로 보낸다")
    extra = sorted(set(rec) - ALLOWED)
    if extra:
        raise WriteRejected("schema_invalid", f"허용하지 않는 필드: {extra}")  # author, actor, origin 포함
    for k in ("title", "body", "type", "id"):
        if k in rec and not isinstance(rec[k], str):
            raise WriteRejected("schema_invalid", f"{k}는 문자열")
    if "props" in rec and not isinstance(rec["props"], dict):
        raise WriteRejected("schema_invalid", "props는 객체")
    if "links" in rec and not isinstance(rec["links"], list):
        raise WriteRejected("schema_invalid", "links는 배열")
    ev = rec.get("expected_version")
    if ev is not None and (isinstance(ev, bool) or not isinstance(ev, int) or ev < 0):
        raise WriteRejected("schema_invalid", "expected_version은 0 이상의 정수")


def _links(rec: dict, warnings: list[str]) -> list[dict]:
    seen: dict[tuple[str, str], dict] = {}
    for ln in rec.get("links") or []:
        if not isinstance(ln, dict) or not isinstance(ln.get("rtype"), str) or not isinstance(ln.get("dst"), str) \
                or not ln["rtype"] or not ln["dst"]:
            raise WriteRejected("schema_invalid", "links 항목은 {rtype, dst} 문자열")
        seen[(ln["rtype"], ln["dst"])] = {"rtype": ln["rtype"], "dst": ln["dst"]}
    for t in wiki_targets(rec.get("body") or ""):
        try:
            check_public_id(t)
        except ValueError:
            if f"link_not_id:{t}" not in warnings:
                warnings.append(f"link_not_id:{t}")
            continue
        seen.setdefault(("LINKS_TO", t), {"rtype": "LINKS_TO", "dst": t})
    return [seen[k] for k in sorted(seen)]


def build_payload(rec: dict, rid: str, warnings: list[str], *, scan: bool = True) -> dict:
    _check_shape(rec)
    title = rec.get("title")
    if not title or not title.strip():
        raise WriteRejected("schema_invalid", "title 필수")
    if "body" not in rec:
        raise WriteRejected("schema_invalid", "body 필수")
    typ = rec.get("type") or "Record"
    if not types.TYPE_NAME_RE.fullmatch(typ):
        raise WriteRejected("schema_invalid", f"type 형식 위반: {typ!r}")
    sens = rec.get("sensitivity") or "internal"
    if sens not in SENS:
        raise WriteRejected("schema_invalid", f"sensitivity 오류: {sens!r}")
    fmt = rec.get("body_format") or "markdown"
    if fmt not in ("markdown", "text"):
        raise WriteRejected("schema_invalid", f"body_format 오류: {fmt!r}")
    ret = rec.get("retention")
    if ret is not None and ret not in ("permanent", "ttl30", "purgeable"):
        raise WriteRejected("schema_invalid", f"retention 오류: {ret!r}")
    try:
        check_public_id(rid)
    except ValueError as e:
        raise WriteRejected("schema_invalid", str(e)) from e
    p: dict = {"id": rid, "type": typ, "title": title, "body": rec["body"], "body_format": fmt, "sensitivity": sens}
    if ret:
        p["retention"] = ret
    props = dict(rec.get("props") or {})
    links = _links({**rec, "links": rec.get("links")}, warnings)
    if scan:
        hits = secrets_scan.scan_record({"title": title, "body": rec["body"], "props": props, "links": links})
        if hits:
            if sens != "secret":
                props["quarantine_from"] = sens
            props["quarantine"] = True
            props["quarantine_rules"] = hits
            p["sensitivity"] = "secret"
            warnings.append("secret_detected:" + ",".join(hits))
    if props:
        p["props"] = props
    if links:
        p["links"] = links
    return p


def _expected_check(led, rec: dict, rid: str, supplied_id: bool) -> int | None:
    head = ledger.record_head(led, rid)
    exp = rec.get("expected_version")
    if head is None:
        return exp
    if supplied_id and exp is None:
        raise WriteRejected("expected_version_required", f"{rid}: 기존 레코드 갱신에는 expected_version이 필요하다(현재 {head[0]})")
    return exp


def put_record(record: dict, idempotency_key: str, transport: str, session: str | None = None, *,
               tty: bool | None = None, scan: bool = True) -> WriteResult:
    """first_party 레코드를 쓴다. transport: mcp | inbox | cli | intake. 귀속은 author.resolve가 정한다."""
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > MAX_KEY:
        raise WriteRejected("schema_invalid", "idempotency_key 필수(문자열, 256자 이하)")
    au = _author.resolve(transport, session, tty=tty)
    _check_shape(record)
    supplied = bool(record.get("id"))
    rid = record["id"] if supplied else derive_id(idempotency_key)
    warnings: list[str] = []
    payload = build_payload(record, rid, warnings, scan=scan)
    typ = payload["type"]
    led = ledger.open_ledger()
    try:
        prior0 = prior_event(led, idempotency_key)
        exp = record.get("expected_version") if prior0 else _expected_check(led, record, rid, supplied)
        schema = types.type_schema(led, typ)
        if schema is not None and payload.get("props"):
            validate.validate_props(schema, payload["props"], typ)
        events: list[dict] = []
        if not types.known(led, typ):
            events.append(types.provisional_event(typ))
        # 보류 뒤 개방된 재시도와 보류 중 재시도는 처음 시각을 이어받는다
        prior = prior_event(led, idempotency_key)
        if prior and prior["kind"] == "record.put" and "authored_at" in (prior["payload"] or {}):
            payload["authored_at"] = prior["payload"]["authored_at"]
        ev = {"kind": "record.put", "actor": au.actor, "on_behalf_of": au.on_behalf_of, "origin": "first_party",
              "subject": rid, "idem_key": idempotency_key, "payload": payload, "noop_if_same": True}
        if exp is not None:
            ev["expected_version"] = exp
        events.append(ev)
        if not prior:
            held = _held_authored(events)
            if held is not None:
                payload["authored_at"] = held
        res = commit(events, au.actor, _led=led)
    finally:
        led.close()
    res.id = rid
    res.warnings = warnings + res.warnings
    return res


def _held_authored(events: list[dict]) -> int | None:
    import json as _json
    from kb.core import spool
    f = spool.dir_of("fp-held") / f"{hold_name(events)}.json"
    try:
        old = _json.loads(f.read_bytes())
    except (FileNotFoundError, ValueError):
        return None
    for e in old.get("events", []):
        if e.get("kind") == "record.put":
            return e["payload"].get("authored_at")
    return None


def tombstone_record(record_id: str, reason: str, idempotency_key: str, transport: str, session: str | None = None, *,
                     tty: bool | None = None) -> WriteResult:
    if not reason or not isinstance(reason, str):
        raise WriteRejected("schema_invalid", "reason 필수")
    if not isinstance(idempotency_key, str) or not idempotency_key.strip():
        raise WriteRejected("schema_invalid", "idempotency_key 필수")
    au = _author.resolve(transport, session, tty=tty)
    led = ledger.open_ledger()
    try:
        if ledger.record_head(led, record_id) is None:
            raise WriteRejected("not_found", f"없는 레코드: {record_id}")
    finally:
        led.close()
    ev = {"kind": "record.tombstone", "actor": au.actor, "on_behalf_of": au.on_behalf_of, "origin": "first_party",
          "subject": record_id, "idem_key": idempotency_key, "payload": {"id": record_id, "reason": reason}}
    res = commit([ev], au.actor)
    res.id = record_id
    return res
