"""kb_put 경로의 비밀 검사 우회 시험: 호출자가 보낸 props.source_path는 검사를 건너뛰는 근거가 아니다."""
import hashlib
import json

import pytest

KEYISH = "OPENAI_API_KEY=" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"      # 모양만 같은 가짜 값
TOKEN = "ghp_" + hashlib.sha256(b"mcp-bypass").hexdigest()[:36]


def head_payload(rid):
    from kb.core import ledger
    c = ledger.open_ledger()
    try:
        evs = [e for e in ledger.iter_events(c, 0, 100000) if e["subject"] == rid and e["kind"] == "record.put"]
    finally:
        c.close()
    return evs[-1]["payload"]


@pytest.mark.parametrize("sp", ["x.png", "pkg/node_modules/a.js", "go.sum"])
def test_kb_put_quarantines_key_shaped_body_despite_source_path(server, kbenv, sp):
    text, err, _ = server.call("kb_put", record={"type": "Note", "title": "경로 우회", "body": KEYISH,
                                                  "props": {"source_path": sp}}, idempotency_key="mcp-byp-" + sp)
    assert not err
    r = json.loads(text)
    assert any(w.startswith("secret_detected:") for w in r["warnings"])
    p = head_payload(r["id"])
    assert p["sensitivity"] == "secret" and p["props"]["quarantine"] is True
    assert KEYISH.split("=", 1)[1] not in text          # 응답에 값이 없다


def test_kb_put_rejects_secret_in_idempotency_key_without_echo(server):
    text, err, _ = server.call("kb_put", record={"type": "Note", "title": "키", "body": "평범"},
                               idempotency_key=f"note:{TOKEN}")
    assert err and "secret_detected" in text and TOKEN not in text


def test_kb_put_error_text_does_not_echo_field_names(server):
    text, err, _ = server.call("kb_put", record={"title": "t", "body": "b", TOKEN: 1}, idempotency_key="mcp-byp-field")
    assert err and "schema_invalid" in text and TOKEN not in text
