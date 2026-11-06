"""record 항목의 멱등 키(ingest:<batch>:<ref>) 비밀 검사는 validate(드라이런)와 submit이 같게 판정한다."""
import hashlib

from .conftest import bundle, res, run

TOKEN = "ghp_" + hashlib.sha256(b"ingest-key").hexdigest()[:36]


def test_secret_in_ref_is_rejected_by_validate_and_submit(env):
    from kb import ingest
    item = {"item": "record", "ref": TOKEN, "title": "메모", "body": "본문", "sensitivity": "internal"}
    v = res(run([item], producer="user:sagae"), TOKEN)
    s = res(ingest.submit(bundle([item], producer="user:sagae"), fetch=False), TOKEN)
    assert v["code"] == s["code"] == "E_POLICY"
    assert s["result"] == "rejected"
    assert TOKEN not in str(v.get("detail")) and TOKEN not in str(s.get("detail"))


def test_digest_ref_after_keyword_batch_passes_both(env):
    from kb import ingest
    ref = hashlib.sha256(b"r").hexdigest()[:16]
    item = {"item": "record", "ref": ref, "title": "메모", "body": "본문", "sensitivity": "internal"}
    hdr = {"batch": "b-auth-20261104"}
    v = res(run([item], producer="user:sagae", **hdr), ref)
    s = res(ingest.submit(bundle([item], producer="user:sagae", **hdr), fetch=False), ref)
    assert v["result"] in ("held", "accepted") and s["result"] in ("held", "accepted", "written"), (v, s)
