import json
import struct
from pathlib import Path

import pytest
import yaml

from kb.core import cas, ids, ledger
from kb.project import rebuild

REPO = Path(__file__).resolve().parents[2]
FX = Path(__file__).resolve().parent / "fixtures"


def base_sources(dest: Path) -> Path:
    """overlays를 뺀 sources 사본(심볼릭 링크)을 dest에 만든다. 기본 레지스트리 시험용."""
    for p in (REPO / "sources").iterdir():
        if p.name != "overlays":
            (dest / p.name).symlink_to(p)
    return dest


def fx(name: str) -> bytes:
    return (FX / name).read_bytes()


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME + 임시 설정 폴더 + KB_SHARE(sources는 시험용 빈 레지스트리, schemas는 저장소 것)."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    (share / "sources" / "domains").mkdir(parents=True)
    (share / "sources" / "internal.d").mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources" / "classes.yaml").write_text((REPO / "sources" / "classes.yaml").read_text())
    (share / "sources" / "host-policy.yaml").write_text((REPO / "sources" / "host-policy.yaml").read_text())
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def mk_source(sid="src:t", parser="page_md@1", **kw):
    from kb.collect import registry
    raw = {"id": sid, "name": sid, "domain": ["G"], "class": "rel", "parser": parser,
           "fetch": {"kind": "https", "url": "https://t.example/x"},
           "policy": {"enabled": True, "tos": "allowed", "robots": "enforce", "trust": "primary"}}
    raw.update(kw)
    return registry._build(raw)


def capture(url, body: bytes, ctype="text/plain", source="src:t", fetched_at=1_790_000_000_000):
    """CAS에 원본을 넣고 snapshot.captured를 쓴다. payload를 돌려준다."""
    from kb.write import commit
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": ["G"], "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    return p


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path())


def make_pdf(pages: list[str]) -> bytes:
    """텍스트만 있는 최소 PDF(Helvetica). 시험용."""
    objs: list[bytes] = []
    n = len(pages)
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_id = 3 + 2 * n
    for i, text in enumerate(pages):
        content = ("BT /F1 10 Tf 20 750 Td " + " ".join(
            f"({ln.replace(chr(92), '').replace('(', '').replace(')', '')}) Tj 0 -12 Td" for ln in text.split("\n")) + " ET").encode()
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return bytes(out)
