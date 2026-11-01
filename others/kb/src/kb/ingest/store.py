"""gold 읽기와 스냅샷 본문 적재. 적재 계약은 읽기 전용 질의만 하고, 쓰기는 process.py가 commit으로 한다."""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field

from kb.core import cas
from kb.core.canon import sha256_hex

DAY_MS = 86400_000
REUSE_MS = DAY_MS


def jl(b):
    return None if b is None else json.loads(b)


class Gold:
    """current gold의 읽기 연결. 빌드가 바뀌면 다시 연다. 연결은 길게 쓰므로 마감 시간을 넉넉히 준다."""

    def __init__(self):
        self.con = None
        self.path = None
        self._alias_cache = None

    def conn(self):
        from kb.core.conn import connect_ro
        from kb.project import current_gold_path
        p = current_gold_path()
        if p is None:
            self.close()
            return None
        real = os.path.realpath(p)                       # current는 symlink다. 재구축이 가리키는 빌드를 바꿔도 이름은 그대로다
        if self.con is None or real != self.path:
            self.close()
            self.con = connect_ro(real, 3600.0)
            self.path = real
        return self.con

    def close(self):
        if self.con is not None:
            self.con.close()
        self.con, self.path = None, None

    def node(self, nid: str) -> dict | None:
        c = self.conn()
        if c is None:
            return None
        r = c.execute("SELECT type, label, props, liveness, status, recorded_at, version FROM node "
                      "WHERE id=? AND expired_at IS NULL", (nid,)).fetchone()
        if not r:
            return None
        return {"id": nid, "type": r[0], "label": r[1], "props": jl(r[2]) or {}, "liveness": r[3], "status": r[4],
                "recorded_at": r[5], "version": r[6]}

    def domains(self, nid: str) -> list:
        c = self.conn()
        return [x[0] for x in c.execute("SELECT domain FROM node_domain WHERE node_id=?", (nid,))] if c else []

    def forms(self, nid: str) -> list:
        """라벨과 별칭(정규화 형태)."""
        c = self.conn()
        n = self.node(nid)
        if c is None or n is None:
            return []
        return [n["label"], *[x[0] for x in c.execute("SELECT norm FROM alias WHERE node_id=?", (nid,))]]

    def all_aliases(self) -> dict:
        """정규화 별칭 -> 엔티티 ID. 처리 한 번에 한 번만 읽는다. 너무 짧은 별칭은 뺀다."""
        if self._alias_cache is None:
            c = self.conn()
            out: dict = {}
            if c is not None:
                for norm, nid in c.execute("SELECT a.norm, a.node_id FROM alias a JOIN node n ON n.id=a.node_id "
                                           "AND n.expired_at IS NULL AND n.type NOT IN ('Claim','Snapshot','Document','Record')"):
                    if len(norm) >= 3 or re.search("[가-힣]", norm) and len(norm) >= 2:
                        out.setdefault(norm, nid)
            self._alias_cache = out
        return self._alias_cache

    def snapshots_of_url(self, url: str) -> list:
        """URL의 스냅샷 노드 props 목록(fetched_at 내림차순)."""
        from kb.core.ids import document_id
        c = self.conn()
        if c is None:
            return []
        rows = c.execute("SELECT n.id, n.props FROM edge e JOIN node n ON n.id=e.src AND n.expired_at IS NULL "
                         "WHERE e.dst=? AND e.rtype='SNAPSHOT_OF' AND e.expired_at IS NULL", (document_id(url),)).fetchall()
        out = [dict(jl(p) or {}, id=i) for i, p in rows]
        out.sort(key=lambda d: d.get("fetched_at") or 0, reverse=True)
        return out


@dataclass
class SnapInfo:
    id: str
    url: str
    source: str
    trust: str
    publisher: str | None
    props: dict
    text: str | None = None
    fmt: str = "text"
    text_sha: str | None = None
    title: str = ""
    paras: list = field(default_factory=list)


def doc_title(text: str, fmt: str) -> str:
    if fmt == "json":
        return ""
    lines = text.split("\n", 60)[:60]
    for ln in lines:
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", ln)
        if m:
            return m.group(1)[:200]
    for ln in lines:
        if ln.strip():
            return ln.strip()[:200]
    return ""


def load_text(info: SnapInfo, sources: dict, *, write: bool) -> SnapInfo:
    """표시 본문과 문단. gold에 text_sha가 있으면 CAS에서 읽고, 없으면 원본에서 파서와 같은 방식으로 만든다.
    write이면 새로 만든 본문을 snapshot.text로 남긴다(tick parse가 나중에 같은 이벤트를 쓰므로 멱등)."""
    if info.text is not None:
        return info
    from kb.parse import display, pipeline
    from kb.parse import paragraphs as pg
    p = info.props
    fmt = p.get("text_format") or "text"
    sha = p.get("text_sha")
    if sha:
        info.text = cas.get(sha).decode("utf-8")
        info.text_sha = sha
    else:
        raw = cas.get(p["raw_sha"], p.get("tier") or "objects")
        snap = {"id": info.id, "url": info.url, "source": info.source, "raw_sha": p["raw_sha"],
                "content_type": p.get("content_type"), "tier": p.get("tier") or "objects",
                "fetched_at": p.get("fetched_at")}
        src = sources.get(info.source)
        ad = pipeline.pick_adapter(snap, src)
        needs_pdf = bool(src is not None and (src.expect or {}).get("needs_pdf"))
        txt = display.display_text(raw, p.get("content_type"), hint=ad.hint, url=info.url, needs_pdf=needs_pdf)
        if txt.needs_ocr:
            raise ValueError("needs_ocr")
        info.text, fmt = txt.text, txt.fmt
        info.text_sha = sha256_hex(txt.text.encode("utf-8"))
        if write:
            from kb.write import commit
            cas.put(txt.text.encode("utf-8"))
            paras_sha = pg.store(pg.paragraphs(txt.text, txt.fmt))
            commit([{"kind": "snapshot.text", "actor": "collector", "origin": "system", "subject": info.id,
                     "idem_key": f"snaptext:{info.id}:{txt.extractor}",
                     "payload": {"snapshot": info.id, "text_sha": info.text_sha, "text_format": txt.fmt,
                                 "extractor": txt.extractor, "paras_sha": paras_sha}}], "collector", timeout=60.0)
    info.fmt = fmt
    info.paras = pg.paragraphs(info.text, fmt)
    info.title = doc_title(info.text, fmt)
    return info


def now_ms() -> int:
    return int(time.time() * 1000)
