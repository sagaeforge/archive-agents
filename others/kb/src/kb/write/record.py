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
from datetime import datetime, timezone

from kb.core import cas, ledger
from kb.core.canon import CanonError, canon_json, sha256_hex
from kb.core.ids import SLUG_RE, TYPE_RE, check_public_id
from kb.write import author as _author
from kb.write import secrets_scan, types, validate
from kb.write.engine import WriteResult, commit, hold_name, prior_event
from kb.write.errors import IdemConflict, VersionConflict, WriteRejected

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
    # 식별자 비밀은 형식 오류보다 먼저 거절한다. 격리로 숨길 수 없는 칸이다.
    if scan:
        reject_secret_key("id", rid)
        reject_secret_key("type", typ)
        for k in _prop_names(rec.get("props") or {}):
            reject_secret_key("props 이름", k)
        if typ == "TopicSpec":
            reject_secret_key("slug", (rec.get("props") or {}).get("slug"))
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
               tty: bool | None = None, scan: bool = True, key_digest_tail: bool | None = None,
               token_label: str | None = None, change: str = "save", on_secret: str = "reject",
               dry_run: bool = False) -> WriteResult | dict:
    """first_party 레코드를 쓴다. transport: mcp | inbox | cli | intake. 귀속은 author.resolve가 정한다.

    key_digest_tail: 키의 마지막 칸이 쓰는 쪽이 만든 내용 해시인가. 기본값은 transport가 intake일 때 참이다.
    받은편지함은 True를 넘긴다. 호출자가 키 전체를 정하는 mcp, cli, ingest는 거짓이다.
    """
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > MAX_KEY \
            or "\0" in idempotency_key:
        raise WriteRejected("schema_invalid", "idempotency_key 필수(문자열, 256자 이하)")
    if transport == "http":
        return _editor_put(record, idempotency_key, token_label, change, on_secret, dry_run)
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
                     tty: bool | None = None, token_label: str | None = None, change: str = "save",
                     on_secret: str = "reject", expected_version: int | None = None) -> WriteResult:
    if not reason or not isinstance(reason, str):
        raise WriteRejected("schema_invalid", "reason 필수")
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or "\0" in idempotency_key \
            or len(idempotency_key) > MAX_KEY:
        raise WriteRejected("schema_invalid", "idempotency_key 필수")
    if transport == "http":
        return _editor_tombstone(record_id, reason, idempotency_key, token_label, change, on_secret, expected_version)
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


# 편집기 정책은 기존 MCP/inbox/CLI의 넓은 ID/링크 규칙과 분리한다.
_EDITOR_LINKS = {"Page": {"PART_OF", "LINKS_TO", "ABOUT"}, "Note": {"LINKS_TO", "ABOUT"},
                 "TopicSpec": {"ABOUT", "LINKS_TO"}, "Review": set()}
_EDITOR_MESSAGES = {"schema_invalid": "입력 형식 위반", "secret_detected": "비밀로 보이는 값이 있어 저장하지 않았다",
                    "not_found": "없는 기록", "expected_version_required": "expected_version이 필요하다",
                    "body_too_large": "본문 크기 제한 초과"}


def _editor_error(code):
    return WriteRejected(code, _EDITOR_MESSAGES.get(code, "쓰기 거절"))


def _editor_identifier(value):
    if secrets_scan.scan_key(value):
        raise _editor_error("secret_detected")


def _editor_shape(rec):
    _check_shape(rec)
    if "retention" in rec:
        raise _editor_error("schema_invalid")
    for name in _prop_names(rec.get("props") or {}):
        if name in {"source_path", "path", "file", "filename"} or name.endswith("_path") \
                or name.startswith("quarantine"):
            raise _editor_error("schema_invalid")
    try:
        canon_json(rec)
        if len(canon_json(rec.get("props") or {})) > 16 * 1024:
            raise _editor_error("schema_invalid")
        if len(rec.get("body", "").encode("utf-8")) > 1024 * 1024:
            raise _editor_error("body_too_large")
    except (CanonError, UnicodeError):
        raise _editor_error("schema_invalid") from None
    if len(rec.get("title", "")) > 300 or len(rec.get("links") or []) + len(wiki_targets(rec.get("body", ""))) > 500:
        raise _editor_error("schema_invalid")


def editor_id(actor: str, key: str) -> str:
    digest = hashlib.sha256(b"kb-record-id-editor-v1\0" + actor.encode() + b"\0" + key.encode()).digest()[:16]
    return "f-" + base64.b32encode(digest).decode().lower().rstrip("=")


def _editor_id_shape(value):
    if not isinstance(value, str) or len(value) > 256:
        return False
    if re.fullmatch(r"f-[a-z2-7]{26}|(?:c-|r-|ev-)[a-z2-7]{12}|(?:n-|d-)[0-9a-f]{16}", value):
        return True
    parts = value.split(":")
    return len(parts) == 3 and parts[0] == "e" and bool(TYPE_RE.fullmatch(parts[1])) \
        and bool(SLUG_RE.fullmatch(parts[2]))


def _editor_links(rec, warnings):
    seen = {}
    for link in rec.get("links") or []:
        if not isinstance(link, dict) or not isinstance(link.get("rtype"), str) \
                or link["rtype"] not in _EDITOR_LINKS[rec["type"]] \
                or not _editor_id_shape(link.get("dst")):
            raise _editor_error("schema_invalid")
        seen[link["rtype"], link["dst"]] = {"rtype": link["rtype"], "dst": link["dst"]}
    for index, target in enumerate(wiki_targets(rec.get("body", ""))):
        if not _editor_id_shape(target):
            warnings.append(f"link_not_id:{index}")
        else:
            seen.setdefault(("LINKS_TO", target), {"rtype": "LINKS_TO", "dst": target})
    if rec["type"] == "Review":
        target = rec["props"]["target"]
        seen["REVIEWS", target] = {"rtype": "REVIEWS", "dst": target}
    return [seen[key] for key in sorted(seen)]


def _editor_put(rec, key, label, change, on_secret, dry_run):
    # HTTP는 scan=False/key_digest_tail 같은 내부 호출자 우회를 받지 않는다.
    try:
        au = _author.resolve("http", token_label=label, change=change)
        if on_secret not in ("reject", "quarantine") or (on_secret == "quarantine" and change != "save"):
            raise _editor_error("schema_invalid")
        _editor_shape(rec)
        for value in (key, rec.get("id"), rec.get("type"), *_prop_names(rec.get("props") or {})):
            _editor_identifier(value)
        if rec.get("type") == "TopicSpec":
            _editor_identifier((rec.get("props") or {}).get("slug"))
        hits = secrets_scan.editor_hits(rec)
        if hits and on_secret == "reject" and not dry_run:
            exc = _editor_error("secret_detected")
            exc.hits, exc.stored = hits, False
            raise exc
        supplied = bool(rec.get("id"))
        rid = rec["id"] if supplied else editor_id(au.actor, key)
        if not re.fullmatch(r"f-[a-z2-7]{26}", rid):
            raise _editor_error("schema_invalid")
        normalized = types.normalize_first_party(rec, rid)
        warnings = []
        links = _editor_links(normalized, warnings)
        # 공용 링크 해석은 호출하지 않아 이름/접두사만의 가짜 ID를 되살리지 않는다.
        p = build_payload({**normalized, "body": "", "links": []}, rid, [], scan=False)
        p["body"] = normalized["body"]
        if links:
            p["links"] = links
        if hits and on_secret == "quarantine":
            props = p.setdefault("props", {})
            props.update(quarantine=True, quarantine_from=p["sensitivity"],
                         quarantine_rules=sorted({h["rule"] for h in hits}))
            p["sensitivity"] = "secret"
            warnings.append("secret_detected:" + ",".join(props["quarantine_rules"]))
        ev = {"kind": "record.put", "origin": "first_party", "actor": au.actor,
              "on_behalf_of": au.on_behalf_of, "generated_by": au.generated_by,
              "subject": rid, "idem_key": f"h\0{au.actor}\0{key}", "payload": p,
              "noop_if_same": True, "editor_create": not supplied,
              "editor_slug_missing": rec.get("type") == "TopicSpec" and "slug" not in (rec.get("props") or {})}
        if rec.get("expected_version") is not None:
            ev["expected_version"] = rec["expected_version"]
        if dry_run:
            commit([ev], au.actor, dry_run=True)
            return {"would_reject": bool(hits) and on_secret == "reject", "hits": hits,
                    "secret_rules": secrets_scan.editor_rule_contract()}
        res = commit([ev], au.actor)
        res.warnings = warnings + res.warnings
        return res
    except WriteRejected as exc:
        # 모든 편집기 오류는 입력 이름/값이 없는 고정 문구다.
        safe = _editor_error(exc.code)
        if hasattr(exc, "hits"):
            safe.hits, safe.stored = exc.hits, False
        raise safe from None


def _editor_tombstone(rid, reason, key, label, change, on_secret, expected):
    au = _author.resolve("http", token_label=label, change=change)
    if change != "save" or on_secret not in ("reject", "quarantine") or len(reason) > 500:
        raise _editor_error("schema_invalid")
    for value in (rid, reason, key):
        _editor_identifier(value)
    if expected is not None and (isinstance(expected, bool) or not isinstance(expected, int) or expected < 0):
        raise _editor_error("schema_invalid")
    ev = {"kind": "record.tombstone", "origin": "first_party", "actor": au.actor,
          "on_behalf_of": au.on_behalf_of, "generated_by": au.generated_by,
          "subject": rid, "idem_key": f"h\0{au.actor}\0{key}", "payload": {"id": rid, "reason": reason}}
    if expected is not None:
        ev["expected_version"] = expected
    return commit([ev], au.actor)


def _record_state(led, rid):
    head = ledger.record_head(led, rid)
    last = led.execute("SELECT kind, origin, payload_sha, actor, on_behalf_of, generated_by, at, seq "
                       "FROM event WHERE subject=? AND kind IN ('record.put','record.tombstone','record.redact') "
                       "ORDER BY seq DESC LIMIT 1", (rid,)).fetchone()
    put = led.execute("SELECT origin, payload_sha FROM event WHERE subject=? AND kind='record.put' "
                      "ORDER BY seq DESC LIMIT 1", (rid,)).fetchone()
    p = ledger.get_payload(led, put[1]) if put else None
    if head is None or last is None or p is None or last[0] == "record.redact" or put[0] != "first_party" \
            or p.get("type") not in types.FIRST_PARTY_TYPES or p.get("sensitivity") not in ("public", "internal", "private") \
            or (p.get("props") or {}).get("quarantine"):
        raise _editor_error("not_found")
    return head, last, p


def _current(led, rid):
    head, last, p = _record_state(led, rid)
    if last[0] == "record.tombstone":
        return {"version": head[0], "status": "dead"}
    body = p.get("body", "")
    if "body_sha" in p:
        body = cas.get(p["body_sha"], "fp").decode("utf-8")
    return {"version": head[0], "status": "active", "payload_sha": head[1], "actor": last[3],
            "claimed_author": last[4], "generated_by": last[5],
            "recorded_at": datetime.fromtimestamp(last[6] / 1000, timezone.utc).isoformat().replace("+00:00", "Z"),
            "title": p["title"], "body": body[:200000], "body_truncated": len(body) > 200000,
            "props": p.get("props", {}), "links": p.get("links", [])}


def editor_guard(led, ev):
    """Gate + BEGIN IMMEDIATE 안에서만 호출한다. 재적재도 같은 검사를 거친다."""
    rid, p = ev["subject"], ev["payload"]
    prior = prior_event(led, ev["idem_key"])
    head = ledger.record_head(led, rid)
    creating = ev.get("editor_create", False)
    if prior:
        # 같은 키로 다른 ID를 보낸 경우에도 원래 대상이 숨었는지 먼저 확인한다.
        _record_state(led, prior["subject"])
    if prior or not creating or head:
        head, _, previous = _record_state(led, rid)
        if ev.get("editor_slug_missing"):
            seed = prior["payload"] if prior and prior["subject"] == rid else previous
            props = p.setdefault("props", {})
            props["slug"] = (seed.get("props") or {}).get("slug", props["slug"])
    if prior:
        from kb.write.engine import comparable_payload
        same = prior["kind"] == ev["kind"] and prior["subject"] == rid \
            and all(prior.get(k) == ev.get(k) for k in ("actor", "on_behalf_of", "generated_by")) \
            and comparable_payload(prior["payload"]) == comparable_payload(p)
        if not same:
            if creating:
                raise VersionConflict(current=_current(led, rid))
            raise IdemConflict("같은 키의 쓰기 내용이 다르다")
        if "authored_at" in prior["payload"]:
            p["authored_at"] = prior["payload"]["authored_at"]
        return
    if creating and head:
        raise VersionConflict(current=_current(led, rid))
    if not creating:
        expected = ev.get("expected_version")
        if expected is None:
            raise _editor_error("expected_version_required")
        if expected != head[0]:
            raise VersionConflict(current=_current(led, rid))


def editor_dangling(led, ev):
    warnings = []
    prior = prior_event(led, ev["idem_key"])
    # 재생 경고도 첫 저장 시점의 대상 존재 여부로 재구성한다.
    before = prior["seq"] if prior else ledger.head(led)[0] + 1
    for index, link in enumerate(ev["payload"].get("links") or []):
        if not led.execute("SELECT 1 FROM event WHERE subject=? AND seq<? LIMIT 1", (link["dst"], before)).fetchone():
            warnings.append(f"link_dangling:{index}")
    return warnings
