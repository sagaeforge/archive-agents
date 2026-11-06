"""비밀 검사 우회 시험(ADR-0005 검토 항목 3). 호출자가 보낸 경로 표시는 검사를 건너뛰는 근거가 아니다.
멱등 키, 삭제 사유, props 이름도 검사하고, 오류와 경고에는 입력 값이 들어가지 않는다."""
import hashlib
import json

import pytest

from kb.write import WriteRejected, put_record, secrets_scan, tombstone_record, validate
from wrhelp import events, gold_row

TOKEN = "ghp_" + hashlib.sha256(b"bypass").hexdigest()[:36]
ENV_BODY = "OPENAI_API_KEY=" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"      # 모양만 같은 가짜 값
ALLOWED_PATHS = ["x.png", "import/shot.png", "a/node_modules/b/index.js", "go.sum", "docs/spec.pdf", "vendor/x/y.go"]


def rec(**kw):
    return {"type": "Note", "title": "우회 시험", "body": "평범", "sensitivity": "internal", **kw}


def stored(rid):
    row = gold_row("SELECT sensitivity, props FROM node WHERE id=? AND expired_at IS NULL", (rid,))[0]
    return row[0], json.loads(row[1]) if row[1] else {}


@pytest.mark.parametrize("sp", ALLOWED_PATHS)
def test_source_path_does_not_exempt_scan(sp):
    assert secrets_scan.scan_record({"title": "t", "body": f"토큰 {TOKEN}", "props": {"source_path": sp}})
    assert secrets_scan.scan_record({"title": "t", "body": ENV_BODY, "props": {"source_path": sp}})


@pytest.mark.parametrize("sp", ALLOWED_PATHS)
def test_put_record_quarantines_despite_source_path(fp_open, sp):
    res = put_record(rec(body=f"토큰 {TOKEN}", props={"source_path": sp}), "byp-" + sp, "mcp", "s-a")
    assert any(w.startswith("secret_detected:") for w in res.warnings)
    sens, pr = stored(res.id)
    assert sens == 3 and pr["quarantine"] is True and pr["quarantine_from"] == "internal"


def test_other_path_hints_are_ignored(fp_open):
    props = {"path": "x.png", "file": "a.pdf", "filename": "go.sum", "source": "node_modules/x", "sourcePath": "x.png"}
    res = put_record(rec(body=ENV_BODY, props=props), "byp-hints", "mcp", "s-a")
    assert stored(res.id)[0] == 3


def test_plain_record_with_allowlisted_path_still_stores(fp_open):
    res = put_record(rec(props={"source_path": "a/node_modules/x.png"}), "byp-plain", "mcp", "s-a")
    assert not res.warnings and stored(res.id)[0] == 1


def test_inbox_path_scans_too(fp_open):
    from kb.write import inbox
    # 받은편지함도 같은 put_record를 쓴다. 파일 형식과 무관하게 같은 경로를 지나는지 코드 수준에서 확인한다
    import inspect
    assert "put_record" in inspect.getsource(inbox) and "scan=False" not in inspect.getsource(inbox)


# ------------------------------------------------------------------ 메타데이터

def test_idempotency_key_is_scanned(fp_open):
    with pytest.raises(WriteRejected) as ei:
        put_record(rec(), f"note:{TOKEN}", "mcp", "s-a")
    assert ei.value.code == "secret_detected"
    assert TOKEN not in str(ei.value) and "github-pat" in ei.value.message


def test_digest_keys_still_pass(fp_open):
    for i, k in enumerate((f"ingest:foo-bar-baz:{hashlib.sha256(b'x').hexdigest()}",
                           f"harvest:f-abcdefghijklmnopqrstuvwxyz:v1:{hashlib.sha256(b'y').hexdigest()[:16]}",
                           "intake:session-ab12:note-3")):
        res = put_record(rec(title=f"키 {i}"), k, "mcp", "s-a")
        assert not res.warnings


def test_digest_exemption_does_not_hide_labelled_secrets():
    h = hashlib.sha256(b"z").hexdigest()
    assert secrets_scan.scan_key(f"ghp_{h[:36]}")                  # 접두어가 붙은 값은 다이제스트가 아니다
    assert secrets_scan.scan_key(f"app:api_key:{h[:32]}")          # 앞 칸 이름이 비밀스럽다
    assert not secrets_scan.scan_key(f"app:note-name:{h}")


def test_tombstone_reason_and_key_are_scanned(fp_open):
    res = put_record(rec(), "tomb-1", "mcp", "s-a")
    with pytest.raises(WriteRejected) as ei:
        tombstone_record(res.id, f"토큰 {TOKEN} 때문에", "tomb-k1", "cli", tty=True)
    assert ei.value.code == "secret_detected" and TOKEN not in str(ei.value)
    with pytest.raises(WriteRejected) as ei:
        tombstone_record(res.id, "정리", f"tomb:{TOKEN}", "cli", tty=True)
    assert ei.value.code == "secret_detected" and TOKEN not in str(ei.value)
    ok = tombstone_record(res.id, "정리", "tomb-k3", "cli", tty=True)
    assert ok.id == res.id


@pytest.mark.parametrize("props", [{TOKEN: 1}, {"a": {TOKEN: ["x"]}}, {"a": [{TOKEN: 1}]}],
                         ids=["top", "nested", "in-list"])
def test_secret_prop_names_are_rejected_without_echo(fp_open, props):
    with pytest.raises(WriteRejected) as ei:
        put_record(rec(props=props), "byp-name", "mcp", "s-a")
    assert ei.value.code == "secret_detected" and "github-pat" in ei.value.message
    assert TOKEN not in str(ei.value)
    assert not events("kind='record.put'")          # 원장에 아무것도 쓰지 않았다


def test_secret_prop_value_is_still_quarantined(fp_open):
    res = put_record(rec(props={"memo": TOKEN}), "byp-val", "mcp", "s-a")
    assert stored(res.id)[0] == 3


def test_supplied_id_and_type_are_scanned(fp_open):
    for k, kw in (("id", {"id": TOKEN}), ("type", {"type": TOKEN})):
        with pytest.raises(WriteRejected) as ei:
            put_record(rec(**kw), "byp-" + k, "mcp", "s-a")
        assert ei.value.code == "secret_detected" and TOKEN not in str(ei.value)


# ------------------------------------------------------------------ 조립한 내용

def test_secret_split_across_title_body_and_props_is_caught(fp_open):
    a, b = TOKEN[:20], TOKEN[20:]
    assert secrets_scan.scan_record({"title": a, "body": b})
    assert secrets_scan.scan_record({"title": "t", "body": a, "props": {"memo": b}})
    res = put_record(rec(title=a, body=b), "byp-split", "mcp", "s-a")
    assert stored(res.id)[0] == 3


def test_split_with_separator_is_a_documented_limit():
    a, b = TOKEN[:20], TOKEN[20:]
    assert not secrets_scan.scan_record({"title": a, "body": "사이 글 " + b})


# ------------------------------------------------------------------ 오류와 경고에 입력 값이 없다

def _msgs(fn):
    try:
        r = fn()
    except Exception as e:  # noqa: BLE001
        return str(e)
    return " ".join(r.warnings)


def test_error_and_warning_text_never_echo_input(fp_open):
    cases = [
        lambda: put_record({**rec(), TOKEN: 1}, "e1", "mcp", "s-a"),                      # 모르는 필드 이름
        lambda: put_record(rec(type="a b " + TOKEN), "e2", "mcp", "s-a"),                 # 형식 위반 타입
        lambda: put_record(rec(sensitivity=TOKEN), "e3", "mcp", "s-a"),
        lambda: put_record(rec(body_format=TOKEN), "e4", "mcp", "s-a"),
        lambda: put_record(rec(retention=TOKEN), "e5", "mcp", "s-a"),
        lambda: put_record(rec(id="bad id " + TOKEN), "e6", "mcp", "s-a"),
        lambda: put_record(rec(body=f"[[{TOKEN} x y]] 와 [[보통 글]]"), "e7", "mcp", "s-a"),  # 위키 링크 경고
        lambda: put_record(rec(body=f"{TOKEN}"), "e8", "mcp", "s-a"),                     # 비밀 경고
        lambda: put_record(rec(), "e9-marker-ABCDEF", "mcp", "s-a") and put_record(rec(title="다름"), "e9-marker-ABCDEF", "mcp", "s-a"),
        lambda: tombstone_record("f-없는-" + "x" * 10, "정리", "e10", "cli", tty=True),
    ]
    for c in cases:
        m = _msgs(c)
        assert TOKEN not in m and "ABCDEF" not in m and "bad id" not in m, m


def test_wikilink_warning_is_a_count(fp_open):
    res = put_record(rec(body="[[a b c]] [[d e f]]"), "wl", "mcp", "s-a")
    assert res.warnings == ["link_not_id:2"]


def test_schema_error_text_has_no_instance_value():
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "additionalProperties": False}
    for props in ({"n": TOKEN}, {TOKEN: 1}):
        with pytest.raises(WriteRejected) as ei:
            validate.validate_props(schema, props, "T")
        assert TOKEN not in str(ei.value), str(ei.value)


# ------------------------------------------------------------------ 쓰는 쪽이 만든 다이제스트 키(검토 2a 항목 1, 3)

SHA = hashlib.sha256(b"content").hexdigest()
REAL_IN_KEY = {
    "github-pat": f"x:{TOKEN}",
    "anthropic-api-key": "x:sk-ant-api03-" + ("aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9" * 3)[:93] + "AA",
    "aws-access-token": "x:AKIA" + "QZ3MXR7TK2VW5YJ4",
}


@pytest.mark.parametrize("key", [
    f"inbox:api-token-rotation:{SHA[:32]}",      # inbox.py 키, 파일 이름에 token
    f"inbox:auth-design:{SHA[:32]}",
    f"intake:claude-token-usage:{SHA}",          # intake/core.py 키, 항목 ID에 token
    f"intake:sagae-token-notes:{SHA}",           # 원장 seq 8094와 같은 꼴(6자 이름:세 낱말, 가운데 token:sha256)
    f"note:password-policy:{SHA[:24]}",
    f"ingest:b-auth-20261104:{SHA[:16]}",
])
def test_keyword_inside_a_slug_does_not_make_the_digest_a_secret(key):
    assert secrets_scan.scan_key(key) == []


@pytest.mark.parametrize("transport,session", [("intake", "s-a"), ("mcp", "s-a")])
def test_live_seq_8094_key_shape_puts_and_replays(fp_open, transport, session):
    key = f"intake:sagae-token-notes:{SHA}"
    a = put_record(rec(title="8094 꼴"), key, transport, session)
    b = put_record(rec(title="8094 꼴"), key, transport, session)
    assert not a.warnings and b.id == a.id


@pytest.mark.parametrize("label", ["access", "api_key", "accessToken", "github-token", "client_secret", "auth"])
def test_hex_after_a_credential_name_is_still_scanned(label):
    assert secrets_scan.scan_key(f"x:{label}:{SHA[:32]}") == ["generic-api-key"]


def test_writer_digest_tail_is_exempt_even_after_a_credential_name():
    key = f"inbox:rotate-github-token:{SHA[:32]}"
    assert secrets_scan.scan_key(key)                         # 호출자가 키 전체를 정했으면 이름표로 본다
    assert secrets_scan.scan_key(key, digest_tail=True) == []  # 쓰는 쪽이 붙인 내용 해시면 뺀다


@pytest.mark.parametrize("rule,key", sorted(REAL_IN_KEY.items()), ids=sorted(REAL_IN_KEY))
@pytest.mark.parametrize("transport", ["mcp", "intake"])
def test_real_credentials_in_keys_are_rejected_without_echo(fp_open, rule, key, transport):
    assert rule in secrets_scan.scan_key(key, digest_tail=True)
    with pytest.raises(WriteRejected) as ei:
        put_record(rec(), key, transport, "s-a")
    assert ei.value.code == "secret_detected" and rule in ei.value.message
    assert key.split(":", 1)[1] not in str(ei.value)


def test_inbox_file_with_credential_word_in_name_is_written(fp_open):
    from test_inbox import NOTE, put_file
    from kb.core import paths
    from kb.write import inbox
    put_file("api-token-rotation.md", NOTE)
    put_file("rotate-github-token.md", NOTE.replace("쇼츠 후킹 메모", "토큰 교체 메모"))
    r = inbox.scan()
    assert (r.written, r.failed) == (2, [])
    assert not list((paths.inbox_dir() / ".failed").glob("*/*.md"))


def test_label_in_title_and_hex_body_is_not_a_joined_hit(fp_open):
    assert secrets_scan.scan_record({"title": "Rotate the key:", "body": SHA[:32]}) == []
    res = put_record(rec(title="Rotate the key:", body=SHA[:32]), "byp-joined-fp", "mcp", "s-a")
    assert not res.warnings and stored(res.id)[0] == 1


def test_session_name_is_not_echoed():
    from kb.write import author
    with pytest.raises(WriteRejected) as ei:
        author.clean_session(f"bad session {TOKEN}")
    assert TOKEN not in str(ei.value)
    with pytest.raises(WriteRejected) as ei:
        author.resolve(TOKEN)
    assert TOKEN not in str(ei.value)
