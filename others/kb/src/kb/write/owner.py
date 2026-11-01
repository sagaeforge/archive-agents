"""소유자 읽기와 비밀 격리 해제. 둘 다 TTY에서만 동작한다. 같은 UID 앞에서는 실수 방지다."""
from __future__ import annotations

from kb.core import cas, ledger
from kb.write import engine as _commit
from kb.write import record
from kb.write import tty as _tty
from kb.write.errors import WriteRejected


def _need_tty(tty: bool | None) -> None:
    if not (_tty.is_tty() if tty is None else tty):
        raise WriteRejected("tty_required", "TTY에서만 동작한다")


def read_record(record_id: str, *, tty: bool | None = None) -> dict:
    """원장 payload(또는 raw/fp)에서 최신 버전을 읽는다. private, secret 본문도 읽는다."""
    _need_tty(tty)
    led = ledger.open_ledger()
    try:
        head = ledger.record_head(led, record_id)
        if head is None:
            raise WriteRejected("not_found", f"없는 레코드: {record_id}")
        last = led.execute("SELECT kind FROM event WHERE subject=? AND kind IN ('record.put','record.tombstone','record.redact') "
                           "ORDER BY seq DESC LIMIT 1", (record_id,)).fetchone()
        pl = None if (last and last[0] == "record.redact") else ledger.get_payload(led, head[1])
        if pl is None:
            raise WriteRejected("content_removed", f"{record_id}: 본문이 삭제됨(redact)")
    finally:
        led.close()
    out = dict(pl)
    out["version"] = head[0]
    if "body" not in out and out.get("body_sha"):
        out["body"] = cas.get(out["body_sha"], "fp").decode()
    return out


def release_secret(record_id: str, *, tty: bool | None = None, transport: str = "cli"):
    """비밀 탐지 오탐을 되돌린다. 격리 표시를 지우고 원래 민감도로 새 버전을 쓴다."""
    cur = read_record(record_id, tty=tty)
    props = dict(cur.get("props") or {})
    if not props.get("quarantine"):
        raise WriteRejected("not_quarantined", f"{record_id}: 격리 상태가 아니다")
    orig = props.get("quarantine_from") or "internal"
    for k in ("quarantine", "quarantine_rules", "quarantine_from"):
        props.pop(k, None)
    rec = {"id": record_id, "type": cur["type"], "title": cur["title"], "body": cur.get("body", ""),
           "body_format": cur.get("body_format") or "markdown", "sensitivity": orig,
           "expected_version": cur["version"]}
    if props:
        rec["props"] = props
    if cur.get("links"):
        rec["links"] = cur["links"]
    if cur.get("retention"):
        rec["retention"] = cur["retention"]
    return record.put_record(rec, f"secret-release:{record_id}:v{cur['version']}", transport, tty=tty, scan=False)
