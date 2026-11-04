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
_NAME_OK = re.compile(r"[A-Za-z][A-Za-z_]{0,31}")


def _name(s) -> str:
    """오류 문구에 넣어도 되는 이름만 돌려준다. 호출자가 보낸 값이 비밀일 수 있어 짧은 식별자 꼴만 남긴다."""
    return s if isinstance(s, str) and _NAME_OK.fullmatch(s) else "<표시 안 함>"


# 이 전송의 키는 서버 안의 쓰는 쪽(intake/core.py, harvest/core.py)만 만들고 마지막 칸이 언제나 내용 해시다
_DIGEST_TAIL_TRANSPORTS = frozenset({"intake"})


def reject_secret_key(field: str, value, *, digest_tail: bool = False) -> None:
    """원장에 그대로 남는 식별자(멱등 키, ID, 타입, 삭제 사유)에 비밀이 있으면 거부한다. 규칙 ID만 알린다.

    이 값들은 격리할 수 없는 메타데이터라서(이벤트 머리, 목록, 오류에 보인다) 격리하지 않고 거부한다.
    digest_tail=True는 쓰는 쪽이 키의 마지막 칸을 내용 해시로 직접 붙였다는 뜻이다(secrets_scan.scan_key).
    """
    hits = secrets_scan.scan_key(value, digest_tail=digest_tail)
    if hits:
        raise WriteRejected("secret_detected", f"{field}에 비밀로 보이는 값이 있다(규칙: {','.join(hits)}). 값은 어디에도 남기지 않았다")


def _prop_names(obj):
    """props 안의 모든 객체 키(중첩 포함). 이름은 값과 달리 격리할 수 없는 메타데이터다."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield str(k)
            yield from _prop_names(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _prop_names(v)


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
    extra = sorted(set(rec) - ALLOWED, key=str)
    if extra:
        raise WriteRejected("schema_invalid", f"허용하지 않는 필드: {[_name(k) for k in extra]}")  # author, actor, origin 포함
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
    not_id = 0
    for ln in rec.get("links") or []:
        if not isinstance(ln, dict) or not isinstance(ln.get("rtype"), str) or not isinstance(ln.get("dst"), str) \
                or not ln["rtype"] or not ln["dst"]:
            raise WriteRejected("schema_invalid", "links 항목은 {rtype, dst} 문자열")
        seen[(ln["rtype"], ln["dst"])] = {"rtype": ln["rtype"], "dst": ln["dst"]}
    for t in wiki_targets(rec.get("body") or ""):
        try:
            check_public_id(t)
        except ValueError:
            not_id += 1       # 본문의 글자를 경고에 되돌려 주지 않는다(비밀이 로그에 남을 수 있다)
            continue
        seen.setdefault(("LINKS_TO", t), {"rtype": "LINKS_TO", "dst": t})
    if not_id:
        warnings.append(f"link_not_id:{not_id}")
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
        raise WriteRejected("schema_invalid", "type 형식 위반")
    sens = rec.get("sensitivity") or "internal"
    if sens not in SENS:
        raise WriteRejected("schema_invalid", f"sensitivity는 {'|'.join(SENS)} 중 하나")
    fmt = rec.get("body_format") or "markdown"
    if fmt not in ("markdown", "text"):
        raise WriteRejected("schema_invalid", "body_format은 markdown|text 중 하나")
    ret = rec.get("retention")
    if ret is not None and ret not in ("permanent", "ttl30", "purgeable"):
        raise WriteRejected("schema_invalid", "retention은 permanent|ttl30|purgeable 중 하나")
    try:
        check_public_id(rid)
    except ValueError:
        raise WriteRejected("schema_invalid", "id 형식 위반") from None
    if scan:
        reject_secret_key("id", rid)
        reject_secret_key("type", typ)
        for k in _prop_names(rec.get("props") or {}):
            reject_secret_key("props 이름", k)
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
        raise WriteRejected("expected_version_required", f"기존 레코드 갱신에는 expected_version이 필요하다(현재 {head[0]})")
    return exp


def put_record(record: dict, idempotency_key: str, transport: str, session: str | None = None, *,
               tty: bool | None = None, scan: bool = True, key_digest_tail: bool | None = None) -> WriteResult:
    """first_party 레코드를 쓴다. transport: mcp | inbox | cli | intake. 귀속은 author.resolve가 정한다.

    key_digest_tail: 키의 마지막 칸이 쓰는 쪽이 만든 내용 해시인가. 기본값은 transport가 intake일 때 참이다.
    받은편지함은 True를 넘긴다. 호출자가 키 전체를 정하는 mcp, cli, ingest는 거짓이다.
    """
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > MAX_KEY:
        raise WriteRejected("schema_invalid", "idempotency_key 필수(문자열, 256자 이하)")
    if scan:
        tail = transport in _DIGEST_TAIL_TRANSPORTS if key_digest_tail is None else key_digest_tail
        reject_secret_key("idempotency_key", idempotency_key, digest_tail=tail)
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
    reject_secret_key("idempotency_key", idempotency_key)
    reject_secret_key("reason", reason)
    reject_secret_key("record_id", record_id)
    au = _author.resolve(transport, session, tty=tty)
    led = ledger.open_ledger()
    try:
        if ledger.record_head(led, record_id) is None:
            raise WriteRejected("not_found", "없는 레코드")
    finally:
        led.close()
    ev = {"kind": "record.tombstone", "actor": au.actor, "on_behalf_of": au.on_behalf_of, "origin": "first_party",
          "subject": record_id, "idem_key": idempotency_key, "payload": {"id": record_id, "reason": reason}}
    res = commit([ev], au.actor)
    res.id = record_id
    return res
