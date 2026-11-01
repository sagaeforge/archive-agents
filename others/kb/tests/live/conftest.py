import json
from pathlib import Path

import pytest

from kb.core import cas, ids, ledger
from kb.project import rebuild

REPO = Path(__file__).resolve().parents[2]
NOW = 1_800_000_000_000          # 2027-01-15


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME + 임시 설정 + KB_SHARE. 네트워크는 쓰지 않는다."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    (share / "sources" / "domains").mkdir(parents=True)
    (share / "sources" / "internal.d").mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    for n in ("classes.yaml", "host-policy.yaml"):
        (share / "sources" / n).write_text((REPO / "sources" / n).read_text())
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def commit(events, actor="t"):
    from kb.write import commit as c
    return c(events, actor)


def ev(kind, payload, subject=None, key=None, origin="external"):
    return {"kind": kind, "actor": "t", "origin": origin, "subject": subject,
            "idem_key": key or f"t:{kind}:{subject}:{json.dumps(payload, sort_keys=True)[:60]}", "payload": payload}


def source(sid="src:prim", trust="primary"):
    commit([ev("source.registered", {"id": sid, "label": sid, "props": {"tos": "allowed", "trust": trust, "domain": ["G"]}}, sid)])
    return sid


def capture(url, body: bytes, src="src:prim"):
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": src, "url": url, "raw_sha": sha,
         "content_type": "text/plain", "bytes": len(body), "fetched_at": NOW, "domain": ["G"], "tier": "objects"}
    commit([ev("snapshot.captured", p, sid, key=f"snapshot:{sid}")])
    return sid


def put_entity(eid, typ, label, domain=("G",), liveness=None, props=None):
    p = {"id": eid, "type": typ, "label": label, "domain": list(domain)}
    if props:
        p["props"] = props
    if liveness:
        p["liveness"] = {"state": liveness, "liveness": liveness, "status": "active"}
    commit([ev("entity.put", p, eid, key=f"t:ent:{eid}:{liveness}:{json.dumps(props, sort_keys=True)}")])


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path())


def node(nid):
    con = gold()
    try:
        r = con.execute("SELECT liveness, status, eff_status, verification, version FROM node WHERE id=? AND expired_at IS NULL", (nid,)).fetchone()
        return dict(zip(("liveness", "status", "eff_status", "verification", "version"), r)) if r else None
    finally:
        con.close()


def det_claim(subject, key, kind="state", text=None):
    snap = capture("https://t.example/" + key, f"# T\n\n{text or 'latest 1.0'}\n".encode())
    cid = ids.claim_id_det(subject, "latest_version", {}, "1.0", None) if kind == "state" else ids.claim_id_llm(subject, key)
    commit([ev("claim.assert", {"id": cid, "subject": subject, "predicate": "latest_version" if kind == "state" else None,
                                "value": "1.0" if kind == "state" else None, "statement": text or "latest 1.0", "kind": kind, "stance": "stated",
                                "method": "deterministic", "verification": "parser_derived",
                                "evidence": [{"snapshot": snap, "selector_kind": "text_quote", "exact": text or "latest 1.0"}]},
                  subject, key=f"claim:{cid}")])
    return cid
