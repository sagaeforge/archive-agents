"""이벤트 하나를 gold에 적용한다(ADR 7.2, 8, 13). 현재 시각, 난수, 네트워크를 읽지 않는다.

입력은 이벤트의 `at`, `seq`와 페이로드, CAS 객체뿐이다. 파서와 LLM을 부르지 않는다.
이벤트가 호출하는 순서만 결과를 정하므로 증분 투영과 전체 재구축의 결과가 같다.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

from kb.core import cas, ids
from kb.core.canon import canon_json, sha256_hex
from kb.core.text import index_tokens, nfc

SENS = {"public": 0, "internal": 1, "private": 2, "secret": 3}
NO_GRAPH = {"extract.run", "extract.rejected", "system.fp_opened"}
DEAD = ("dead", "superseded")

NODE_COLS = ("id", "version", "type", "origin", "status", "eff_status", "liveness", "link_status", "verification",
             "sensitivity", "retention", "label", "content_sha", "body_format", "lang", "props", "author",
             "generated_by", "on_behalf_of", "merged_into", "valid_from", "valid_to", "valid_precision",
             "recorded_at", "expired_at", "seq")
NOT_CARRIED = {"id", "version", "recorded_at", "expired_at", "seq"}
EDGE_COLS = ("id", "version", "src", "rtype", "dst", "props", "claim_id", "status", "sensitivity",
             "valid_from", "valid_to", "recorded_at", "expired_at", "seq")
SPAN_COLS = ("unit_rid", "ref_id", "ref_kind", "subject", "claim_kind", "type", "origin", "status", "eff_status",
             "verification", "sensitivity", "start_cp", "end_cp", "snapshot_id", "source_id", "valid_from",
             "valid_to", "rec_from", "rec_to")


class MissingObject(Exception):
    """CAS 객체가 없다. 일반 재구축은 치명 오류다."""

    def __init__(self, shas):
        self.shas = sorted(set(shas))
        super().__init__("CAS 객체 없음: " + ", ".join(s[:12] for s in self.shas))


# ---------------------------------------------------------------- 작은 도구

def one(g: sqlite3.Connection, sql: str, a=()) -> dict | None:
    cur = g.execute(sql, a)
    r = cur.fetchone()
    return dict(zip([d[0] for d in cur.description], r)) if r else None


def many(g: sqlite3.Connection, sql: str, a=()) -> list[dict]:
    cur = g.execute(sql, a)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def jb(o) -> bytes | None:
    return None if o is None else canon_json(o)


def jl(b):
    return None if b is None else json.loads(b)


_TS = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$")
_Q = re.compile(r"^(\d{4})-?Q([1-4])$", re.I)


def parse_time(s) -> tuple[int | None, str | None]:
    """ISO 문자열 -> (UTC ms, 정밀도). 정수 문자열은 ms로 본다."""
    if s is None or s == "":
        return None, None
    if isinstance(s, int):
        return s, "instant"
    s = str(s).strip()
    if re.fullmatch(r"\d{11,}", s):
        return int(s), "instant"
    q = _Q.match(s)
    if q:
        dt = datetime(int(q.group(1)), 3 * int(q.group(2)) - 2, 1, tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000), "quarter"
    m = _TS.match(s)
    if not m:
        raise ValueError(f"시각 형식 오류: {s!r}")
    y, mo, d, hh, mm, ss, _z, sign, oh, om = m.groups()
    prec = "year" if mo is None else "month" if d is None else "day" if hh is None else "instant"
    dt = datetime(int(y), int(mo or 1), int(d or 1), int(hh or 0), int(mm or 0), int(ss or 0), tzinfo=timezone.utc)
    ms = int(dt.timestamp() * 1000)
    if sign:  # 오프셋이 있는 시각은 UTC로 환산한다
        off = (int(oh) * 60 + int(om)) * 60000
        ms += -off if sign == "+" else off
    return ms, prec


def norm_alias(s: str) -> str:
    return " ".join(nfc(s).lower().split())


class Ctx:
    def __init__(self, g: sqlite3.Connection, led: sqlite3.Connection | None = None, missing: str = "quarantine"):
        self.g, self.led, self.mode = g, led, missing
        self.missing: list[str] = []
        self.cost = 0
        self.e: dict = {}
        self.sub = 0
        self.cache: dict = {}
        self.skip: set[int] = set()

    # CAS 객체. mode: quarantine(예외 그대로), fatal(MissingObject), skip(없는 목록에 기록하고 None)
    def obj(self, sha: str, tier: str = "objects") -> bytes | None:
        key = (tier, sha)
        if key in self.cache:
            return self.cache[key]
        try:
            data = cas.get(sha, tier)
        except (cas.CasMissing, cas.CasCorrupt) as e:
            if self.mode == "skip":
                self.missing.append(sha)
                return None
            if self.mode == "fatal":
                raise MissingObject([sha]) from e
            raise
        self.cache[key] = data
        return data

    def begin(self, e: dict) -> None:
        self.e, self.sub, self.cost = e, 0, 0

    @property
    def at(self) -> int:
        return self.e["at"]

    @property
    def seq(self) -> int:
        return self.e["seq"]


# ---------------------------------------------------------------- 노드, 엣지, 헤드

def cur_node(g, nid: str) -> dict | None:
    return one(g, "SELECT * FROM node WHERE id=? AND expired_at IS NULL ORDER BY version DESC LIMIT 1", (nid,))


def cur_edge(g, eid: str) -> dict | None:
    return one(g, "SELECT * FROM edge WHERE id=? AND expired_at IS NULL ORDER BY version DESC LIMIT 1", (eid,))


def head_sens(g, nid: str) -> int:
    r = g.execute("SELECT sensitivity FROM head WHERE id=?", (nid,)).fetchone()
    return r[0] if r else 0


def add_change(c: Ctx, id_, version, typ, sens, kind=None) -> None:
    e = c.e
    c.g.execute("INSERT OR REPLACE INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,0,?,?,?,?,?,?,?)",
                (e["seq"], e["at"], kind or e["kind"], id_, version, e["origin"], typ, sens))


def revoke(c: Ctx, id_, version, typ) -> None:
    c.sub += 1
    c.g.execute("INSERT INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,?,?,?,?,?,?,?,0)",
                (c.seq, c.sub, c.at, "visibility.revoked", id_, version, c.e["origin"], typ))


def edge_sens(c: Ctx, src: str, dst: str, claim_id: str | None, explicit: int = 0) -> int:
    s = max(head_sens(c.g, src), head_sens(c.g, dst), explicit)
    if claim_id:
        s = max(s, head_sens(c.g, claim_id))
    return s


def node_new(c: Ctx, nid: str, prev: dict | None = None, **o) -> dict:
    g, e = c.g, c.e
    if prev is None:
        prev = cur_node(g, nid)
    row = {"type": "Record", "origin": e["origin"], "status": "active", "eff_status": "active", "liveness": None,
           "link_status": None, "verification": None, "sensitivity": 0, "retention": "permanent", "label": "",
           "content_sha": None, "body_format": None, "lang": None, "props": None, "author": None,
           "generated_by": None, "on_behalf_of": None, "merged_into": None, "valid_from": None,
           "valid_to": None, "valid_precision": None}
    if prev:
        row.update({k: v for k, v in prev.items() if k in row})
        g.execute("UPDATE node SET expired_at=? WHERE vid=?", (c.at, prev["vid"]))
    row.update(o)
    row.update(id=nid, version=(prev["version"] + 1 if prev else 1), recorded_at=c.at, expired_at=None, seq=c.seq)
    cur = g.execute(f"INSERT INTO node({','.join(NODE_COLS)}) VALUES({','.join('?' * len(NODE_COLS))})",
                    [row[k] for k in NODE_COLS])
    row["vid"] = cur.lastrowid
    h = one(g, "SELECT * FROM head WHERE id=?", (nid,))
    if h is None:
        g.execute("INSERT INTO head(id,kind,version,sensitivity,merged_into_final) VALUES(?,?,?,?,NULL)",
                  (nid, "node", row["version"], row["sensitivity"]))
    else:
        g.execute("UPDATE head SET version=?, sensitivity=? WHERE id=?", (row["version"], row["sensitivity"], nid))
        if row["sensitivity"] != h["sensitivity"]:
            if row["sensitivity"] > h["sensitivity"]:
                revoke(c, nid, row["version"], row["type"])
            _propagate_sens(c, nid)
    return row


def _propagate_sens(c: Ctx, nid: str) -> None:
    g = c.g
    for ed in many(g, "SELECT * FROM edge WHERE (src=? OR dst=?) AND expired_at IS NULL", (nid, nid)):
        explicit = SENS.get((jl(ed["props"]) or {}).get("sensitivity"), 0) if isinstance(jl(ed["props"]), dict) else 0
        new = edge_sens(c, ed["src"], ed["dst"], ed["claim_id"], explicit)
        old = head_sens(g, ed["id"])
        if new == old:
            continue
        g.execute("UPDATE edge SET sensitivity=? WHERE vid=?", (new, ed["vid"]))
        g.execute("UPDATE head SET sensitivity=? WHERE id=?", (new, ed["id"]))
        if new > old:
            revoke(c, ed["id"], ed["version"], ed["rtype"])


def edge_new(c: Ctx, eid: str, src: str, rtype: str, dst: str, *, props=None, claim_id=None, status="active",
             valid_from=None, valid_to=None, explicit: int = 0) -> dict | None:
    """같은 내용이면 새 버전을 만들지 않는다(None)."""
    g = c.g
    prev = cur_edge(g, eid)
    sens = edge_sens(c, src, dst, claim_id, explicit)
    pb = jb(props)
    if prev and (prev["src"], prev["rtype"], prev["dst"], prev["props"], prev["claim_id"], prev["status"],
                 prev["valid_from"], prev["valid_to"], prev["sensitivity"]) == \
            (src, rtype, dst, pb, claim_id, status, valid_from, valid_to, sens):
        return None
    if prev:
        g.execute("UPDATE edge SET expired_at=? WHERE vid=?", (c.at, prev["vid"]))
    top = g.execute("SELECT max(version) FROM edge WHERE id=?", (eid,)).fetchone()[0]
    ver = (top or 0) + 1  # 만료된 엣지를 다시 만들어도 UNIQUE(id, version)에 걸리지 않는다
    cur = g.execute(f"INSERT INTO edge({','.join(EDGE_COLS)}) VALUES({','.join('?' * len(EDGE_COLS))})",
                    (eid, ver, src, rtype, dst, pb, claim_id, status, sens, valid_from, valid_to, c.at, None, c.seq))
    h = one(g, "SELECT * FROM head WHERE id=?", (eid,))
    if h is None:
        g.execute("INSERT INTO head(id,kind,version,sensitivity,merged_into_final) VALUES(?,?,?,?,NULL)",
                  (eid, "edge", ver, sens))
    else:
        g.execute("UPDATE head SET version=?, sensitivity=? WHERE id=?", (ver, sens, eid))
        if sens > h["sensitivity"]:
            revoke(c, eid, ver, rtype)
    return {"vid": cur.lastrowid, "id": eid, "version": ver, "sensitivity": sens}


# ---------------------------------------------------------------- 검색 단위

def unit_for(c: Ctx, text: str, kind: str, sha: str | None = None) -> int:
    g = c.g
    sha = sha or sha256_hex(nfc(text))
    r = g.execute("SELECT rid FROM unit WHERE sha=?", (sha,)).fetchone()
    if r:
        return r[0]
    rid = g.execute("INSERT INTO unit(sha,kind) VALUES(?,?)", (sha, kind)).lastrowid
    g.execute("INSERT INTO fts(rowid,tok) VALUES(?,?)", (rid, " ".join(index_tokens(text))))
    return rid


def span_open(c: Ctx, **f) -> int:
    row = {k: None for k in SPAN_COLS}
    row.update(f)
    row.setdefault("rec_from", c.at)
    if row["rec_from"] is None:
        row["rec_from"] = c.at
    return c.g.execute(f"INSERT INTO span({','.join(SPAN_COLS)}) VALUES({','.join('?' * len(SPAN_COLS))})",
                       [row[k] for k in SPAN_COLS]).lastrowid


def respan(c: Ctx, ref_id: str, **change) -> int:
    """열린 span을 닫고 바뀐 값으로 다시 연다. 같은 unit이라 FTS는 다시 쓰지 않는다."""
    n = 0
    for s in many(c.g, "SELECT * FROM span WHERE ref_id=? AND rec_to IS NULL ORDER BY sid", (ref_id,)):
        c.g.execute("UPDATE span SET rec_to=? WHERE sid=?", (c.at, s["sid"]))
        s.update(change)
        s["rec_from"], s["rec_to"] = c.at, None
        span_open(c, **{k: s[k] for k in SPAN_COLS})
        n += 1
    return n


def close_spans(c: Ctx, ref_id: str) -> None:
    c.g.execute("UPDATE span SET rec_to=? WHERE ref_id=? AND rec_to IS NULL", (c.at, ref_id))


def add_domains(g, node_id: str, domains) -> None:
    for d in sorted(set(domains or [])):
        g.execute("INSERT OR IGNORE INTO node_domain(domain,node_id) VALUES(?,?)", (d, node_id))


def domains_of(g, node_id: str) -> list[str]:
    return [r[0] for r in g.execute("SELECT domain FROM node_domain WHERE node_id=? ORDER BY domain", (node_id,))]


def add_alias(g, node_id: str, text: str, lang=None) -> None:
    n = norm_alias(text)
    if n:
        g.execute("INSERT OR IGNORE INTO alias(norm,node_id,lang) VALUES(?,?,?)", (n, node_id, lang))


# ---------------------------------------------------------------- 핸들러

def apply_event(c: Ctx, e: dict) -> int:
    """이벤트 하나를 적용하고 문단 비용을 돌려준다. 호출자가 SAVEPOINT를 건다."""
    c.begin(e)
    kind = e["kind"]
    if kind in NO_GRAPH:
        return 0
    if e.get("payload") is None:
        if kind == "record.put":
            return _redacted_put(c, e)
        if kind == "record.tombstone":
            h_record_tombstone(c, {"id": e["subject"]})
            return 0
        raise ValueError(f"본문이 지워진 이벤트는 적용할 수 없음: {kind}")
    fn = HANDLERS.get(kind)
    if fn is None:
        raise ValueError(f"알 수 없는 kind: {kind}")
    fn(c, e["payload"])
    return c.cost


def estimate(c: Ctx, e: dict) -> int:
    """문단 예산용 추정. 부작용이 없다."""
    k, p = e["kind"], e.get("payload")
    if p is None:
        return 0
    if k == "snapshot.text":
        try:
            raw = c.obj(p["paras_sha"]) if p.get("paras_sha") else None
            return len(json.loads(raw)) if raw else 0
        except (cas.CasMissing, cas.CasCorrupt, ValueError):
            return 0  # 적용 단계가 같은 오류를 격리 대상으로 다룬다
    if k == "survival.verdict":
        r = c.g.execute("SELECT count(*) FROM claim c JOIN node n ON n.vid=c.vid WHERE c.subject=? AND n.expired_at IS NULL "
                        "AND c.kind IN ('state','howto')", (p.get("target"),)).fetchone()
        return r[0]
    return 0


def _redacted_put(c: Ctx, e: dict) -> int:
    rid = e["subject"]
    row = node_new(c, rid, type="Record", label="[redacted]", sensitivity=3, content_sha=None, props=None,
                   origin=e["origin"], author=e["actor"], verification="first_party")
    close_spans(c, rid)
    add_change(c, rid, row["version"], row["type"], 3)
    return 0


def h_record_put(c: Ctx, p: dict) -> None:
    e, g = c.e, c.g
    rid = p["id"]
    sens = SENS[p["sensitivity"]]
    body = p.get("body")
    if body is not None:
        sha = sha256_hex(body)
        if sens < 3:
            g.execute("INSERT OR IGNORE INTO content(sha,body) VALUES(?,?)", (sha, body))
    else:
        sha = p.get("body_sha")
    vf = p.get("authored_at")
    row = node_new(c, rid, type=p["type"], origin=e["origin"], status="active", eff_status="active",
                   verification="first_party", sensitivity=sens, retention=p.get("retention") or "permanent",
                   label=p["title"], content_sha=sha, body_format=p.get("body_format") or ("markdown" if body is not None else None),
                   props=jb(p.get("props")), author=e["actor"], generated_by=e["generated_by"],
                   on_behalf_of=e["on_behalf_of"], merged_into=None, valid_from=vf, valid_to=None)
    close_spans(c, rid)
    common = dict(ref_id=rid, ref_kind="record", type=p["type"], origin=e["origin"], status="active",
                  eff_status="active", verification="first_party", sensitivity=sens, valid_from=vf)
    span_open(c, unit_rid=unit_for(c, p["title"], "label"), **common)
    if body and sens < 3:
        span_open(c, unit_rid=unit_for(c, body, "body"), **common)
        c.cost += 1
    # 링크: 이 레코드가 만든 엣지만 관리한다
    want = {}
    for ln in p.get("links") or []:
        want[ids.edge_id(rid, ln["rtype"], ln["dst"])] = ln
    for ed in many(g, "SELECT * FROM edge WHERE src=? AND claim_id IS NULL AND expired_at IS NULL", (rid,)):
        if (jl(ed["props"]) or {}).get("record") == rid and ed["id"] not in want:
            g.execute("UPDATE edge SET expired_at=? WHERE vid=?", (c.at, ed["vid"]))
    for eid, ln in sorted(want.items()):
        edge_new(c, eid, rid, ln["rtype"], ln["dst"], props={"record": rid})
    add_change(c, rid, row["version"], row["type"], sens)


def h_record_tombstone(c: Ctx, p: dict) -> None:
    prev = cur_node(c.g, p["id"])
    if prev is None:
        return add_change(c, p["id"], None, None, 0)
    row = node_new(c, p["id"], prev, status="dead", eff_status="dead")
    respan(c, p["id"], status="dead", eff_status="dead")
    add_change(c, p["id"], row["version"], row["type"], row["sensitivity"])


def mark_rebuild_required(c: Ctx) -> None:
    """증분이 할 수 없는 변경. 재구축은 이 표시가 있으면 지문 비교 없이 새 빌드를 채택한다."""
    c.g.execute("INSERT INTO meta(k,v) VALUES('rebuild_required_seq',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                (str(c.seq),))


def h_record_redact(c: Ctx, p: dict) -> None:
    g, rid = c.g, p["id"]
    prev = cur_node(g, rid)
    if prev is None:
        return add_change(c, rid, None, None, 0)
    shas = [r[0] for r in g.execute("SELECT DISTINCT content_sha FROM node WHERE id=? AND content_sha IS NOT NULL", (rid,))]
    row = node_new(c, rid, prev, label="[redacted]", content_sha=None, props=None, sensitivity=3)
    close_spans(c, rid)
    for s in shas:
        g.execute("DELETE FROM content WHERE sha=? AND NOT EXISTS(SELECT 1 FROM node WHERE content_sha=? AND id<>?)", (s, s, rid))
    # 파생(unit, 옛 버전의 label)은 다음 재구축에서 사라진다(ADR 7.9). 재구축이 필요하다는 표시를 남긴다.
    mark_rebuild_required(c)
    add_change(c, rid, row["version"], row["type"], 3)


def h_entity_put(c: Ctx, p: dict) -> None:
    g, e = c.g, c.e
    nid = p["id"]
    prev = cur_node(g, nid)
    liv = p.get("liveness")
    liveness = prev["liveness"] if prev else None  # liveness 없는 재등록은 기존 값을 지키지 않고 덮지도 않는다
    if isinstance(liv, dict):
        liveness = liv.get("liveness") or liv.get("state") or liveness
    props = jb(p.get("props"))
    status = prev["status"] if prev else "active"
    if isinstance(liv, dict) and liv.get("status") in ("active", "superseded", "dead"):
        status = liv["status"]
    want = (p["type"], p["label"], props, p.get("lang"), liveness, status)
    domains = list(p.get("domain") or [])
    add_domains(g, nid, domains)
    add_alias(g, nid, p["label"], p.get("lang"))
    for a in p.get("aliases") or []:
        add_alias(g, nid, a, p.get("lang"))
    if prev and (prev["type"], prev["label"], prev["props"], prev["lang"], prev["liveness"], prev["status"]) == want:
        return add_change(c, nid, prev["version"], prev["type"], prev["sensitivity"])
    eff = status if status in DEAD and not (prev and prev["merged_into"]) else ("superseded" if prev and prev["merged_into"] else "active")
    row = node_new(c, nid, prev, type=p["type"], origin=e["origin"], status=status, eff_status=eff, liveness=liveness,
                   label=p["label"], props=props, lang=p.get("lang"), author=e["actor"], generated_by=e["generated_by"],
                   on_behalf_of=e["on_behalf_of"])
    close_spans(c, nid)
    span_open(c, unit_rid=unit_for(c, p["label"], "label"), ref_id=nid, ref_kind="node", type=p["type"],
              origin=e["origin"], status=status, eff_status=eff, sensitivity=row["sensitivity"])
    add_change(c, nid, row["version"], row["type"], row["sensitivity"])


def h_entity_alias(c: Ctx, p: dict) -> None:
    add_alias(c.g, p["id"], p["alias"], p.get("lang"))
    n = cur_node(c.g, p["id"])
    add_change(c, p["id"], n["version"] if n else None, n["type"] if n else None, n["sensitivity"] if n else 0)


def h_entity_merge(c: Ctx, p: dict) -> None:
    g = c.g
    src, dst = p["from"], p["into"]
    h = one(g, "SELECT * FROM head WHERE id=?", (dst,))
    final = (h or {}).get("merged_into_final") or dst
    if final == src or src == dst:
        return add_change(c, src, None, None, 0)
    prev = cur_node(g, src)
    ver = typ = None
    sens = 0
    if prev:
        row = node_new(c, src, prev, status="superseded", eff_status="superseded", merged_into=dst)
        respan(c, src, status="superseded", eff_status="superseded")
        ver, typ, sens = row["version"], row["type"], row["sensitivity"]
        g.execute("UPDATE head SET merged_into_final=? WHERE id=?", (final, src))
        edge_new(c, ids.edge_id(src, "MERGED_INTO", dst), src, "MERGED_INTO", dst, props={"merge": True})
    g.execute("UPDATE head SET merged_into_final=? WHERE merged_into_final=?", (final, src))
    add_change(c, src, ver, typ, sens)


def h_edge_put(c: Ctx, p: dict) -> None:
    v = p.get("valid") or {}
    vf, _ = parse_time(v.get("from"))
    vt, _ = parse_time(v.get("to"))
    props = dict(p.get("props") or {})
    explicit = 0
    if p.get("sensitivity"):
        props["sensitivity"] = p["sensitivity"]
        explicit = SENS[p["sensitivity"]]
    r = edge_new(c, p["id"], p["src"], p["rtype"], p["dst"], props=props or None, claim_id=p.get("claim_id"),
                 valid_from=vf, valid_to=vt, explicit=explicit)
    cur = r or cur_edge(c.g, p["id"])
    add_change(c, p["id"], cur["version"], p["rtype"], cur["sensitivity"])


def h_edge_expire(c: Ctx, p: dict) -> None:
    ed = cur_edge(c.g, p["id"])
    if ed is None:
        return add_change(c, p["id"], None, None, 0)
    vt, _ = parse_time(p.get("valid_to"))
    c.g.execute("UPDATE edge SET expired_at=?, valid_to=coalesce(?,valid_to) WHERE vid=?", (c.at, vt, ed["vid"]))
    add_change(c, p["id"], ed["version"], ed["rtype"], ed["sensitivity"])


# ---------- 주장

def snap_info(c: Ctx, sid: str) -> dict:
    n = cur_node(c.g, sid)
    return (jl(n["props"]) or {}) if n else {}


def claim_eff(c: Ctx, status: str, kind: str, subject: str) -> str:
    if status != "active":
        return status
    if kind in ("state", "howto"):
        s = cur_node(c.g, subject)
        if s and s["status"] in DEAD and not s["merged_into"]:
            return s["status"]
    return "active"


def _claim_fields(p: dict) -> tuple:
    return (p["subject"], p.get("predicate"), p.get("object"), p.get("value"), p.get("unit"), jb(p.get("qualifiers")),
            p["statement"], p["kind"], p["stance"], p.get("speaker"), p["method"], p.get("slot"), p.get("extractor"))


def _copy_claim(g, old_vid: int, new_vid: int) -> None:
    g.execute("INSERT INTO claim SELECT ?, subject, predicate, object, value, unit, qualifiers, statement, kind, stance, "
              "speaker, method, slot, conflict_group, change_claim, extractor FROM claim WHERE vid=?", (new_vid, old_vid))


def h_claim_assert(c: Ctx, p: dict) -> None:
    g, e = c.g, c.e
    cid, subj = p["id"], p["subject"]
    prev = cur_node(g, cid)
    vf, vprec = parse_time((p.get("valid") or {}).get("from"))
    vprec = (p.get("valid") or {}).get("precision") or vprec
    vt, _ = parse_time((p.get("valid") or {}).get("to"))
    # ADR 7.9: 파생 주장은 주어, 근거, 원본 레코드 민감도 중 가장 높은 값 아래로 쓰지 않는다. 낮추는 경로는 없다.
    sens = max([head_sens(g, subj), int(p.get("sensitivity_floor") or 0), prev["sensitivity"] if prev else 0,
                *(head_sens(g, ev["snapshot"]) for ev in p["evidence"])])
    infos = [snap_info(c, ev["snapshot"]) for ev in p["evidence"]]
    source_id = next((i.get("source") for i in infos if i.get("source")), None)
    doms = set(p.get("domain") or [])
    if not doms:
        for ev in p["evidence"]:
            doms.update(domains_of(g, ev["snapshot"]))
    add_domains(g, cid, doms)
    add_domains(g, subj, doms)
    same = False
    if prev:
        old = one(g, "SELECT * FROM claim WHERE vid=?", (prev["vid"],))
        oldf = (old["subject"], old["predicate"], old["object"], old["value"], old["unit"], old["qualifiers"], old["statement"],
                old["kind"], old["stance"], old["speaker"], old["method"], old["slot"], old["extractor"])
        same = (oldf == _claim_fields(p) and prev["verification"] == p["verification"] and prev["valid_from"] == vf
                and prev["valid_to"] == vt and prev["sensitivity"] >= sens
                and (prev["status"] == "active" or p["method"] != "llm"))      # 철회된 LLM 주장의 재추출은 되살린다
    row = prev
    if not same:
        status = "active"
        eff = claim_eff(c, status, p["kind"], subj)
        row = node_new(c, cid, prev, type="Claim", origin=e["origin"], status=status, eff_status=eff, liveness=None,
                       verification=p["verification"], sensitivity=sens, retention="permanent", label=p["statement"],
                       props=None, author=e["actor"], generated_by=e["generated_by"], on_behalf_of=e["on_behalf_of"],
                       valid_from=vf, valid_to=vt, valid_precision=vprec, merged_into=None)
        g.execute("INSERT INTO claim(vid,subject,predicate,object,value,unit,qualifiers,statement,kind,stance,speaker,method,"
                  "slot,conflict_group,change_claim,extractor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)",
                  (row["vid"], *_claim_fields(p)[:12], p.get("extractor")))
        close_spans(c, cid)
        span_open(c, unit_rid=unit_for(c, p["statement"], "claim"), ref_id=cid, ref_kind="claim", subject=subj,
                  claim_kind=p["kind"], type="Claim", origin=e["origin"], status=status, eff_status=eff,
                  verification=p["verification"], sensitivity=sens, snapshot_id=p["evidence"][0]["snapshot"],
                  source_id=source_id, valid_from=vf, valid_to=vt)
        c.cost += 1
    for ev in p["evidence"]:
        sel = {"selector_kind": ev["selector_kind"]}
        if ev["selector_kind"] == "jsonpointer":
            sel["json_pointer"] = ev.get("json_pointer")
        elif ev.get("start_cp") is not None:
            sel.update(start_cp=ev.get("start_cp"), end_cp=ev.get("end_cp"))
        else:
            sel["exact"] = ev.get("exact")
        evid = ids.evidence_id(cid, ev["snapshot"], sel)
        g.execute("INSERT OR IGNORE INTO evidence(id,claim_id,snapshot_id,text_sha,selector_kind,exact,prefix,suffix,start_cp,"
                  "end_cp,json_pointer,evidence_state,support_check,gate_version,last_confirmed_at,seq) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?, 'live', NULL, ?,?,?)",
                  (evid, cid, ev["snapshot"], ev.get("text_sha"), ev["selector_kind"], ev.get("exact"), ev.get("prefix"),
                   ev.get("suffix"), ev.get("start_cp"), ev.get("end_cp"), ev.get("json_pointer"),
                   ev.get("gate_version") or "", c.at, c.seq))
    obj = p.get("object")
    if obj and p.get("predicate") and obj.startswith("e:"):
        edge_new(c, ids.edge_id(subj, p["predicate"], obj, {"claim": cid}), subj, p["predicate"], obj,
                 props={"claim": cid}, claim_id=cid, status=row["status"], valid_from=vf, valid_to=vt)
    add_change(c, cid, row["version"], "Claim", row["sensitivity"])


def reversion(c: Ctx, cid: str, *, status=None, verification=None, valid_to=None, set_valid_to=False,
              eff=None) -> dict | None:
    """주장의 새 버전과 새 span을 연다. 바뀐 것이 없으면 None. FTS는 건드리지 않는다."""
    g = c.g
    prev = cur_node(g, cid)
    if prev is None:
        return None
    cl = one(g, "SELECT * FROM claim WHERE vid=?", (prev["vid"],))
    st = status or prev["status"]
    ver = verification or prev["verification"]
    ef = eff if eff is not None else claim_eff(c, st, cl["kind"], cl["subject"])
    vto = valid_to if set_valid_to else prev["valid_to"]
    if (st, ver, ef, vto) == (prev["status"], prev["verification"], prev["eff_status"], prev["valid_to"]):
        return None
    row = node_new(c, cid, prev, status=st, verification=ver, eff_status=ef, valid_to=vto)
    _copy_claim(g, prev["vid"], row["vid"])
    n = respan(c, cid, status=st, eff_status=ef, verification=ver, valid_to=vto)
    c.cost += n
    if st != prev["status"] or vto != prev["valid_to"]:
        for ed in many(g, "SELECT * FROM edge WHERE claim_id=? AND expired_at IS NULL AND rtype NOT IN ('SUPERSEDES')", (cid,)):
            edge_new(c, ed["id"], ed["src"], ed["rtype"], ed["dst"], props=jl(ed["props"]), claim_id=cid, status=st,
                     valid_from=ed["valid_from"], valid_to=vto)
    return row


def h_claim_confirm(c: Ctx, p: dict) -> None:
    g = c.g
    cid = p["id"]
    prev = cur_node(g, cid)
    if prev is None:
        return add_change(c, cid, None, "Claim", 0)
    evs = many(g, "SELECT * FROM evidence WHERE claim_id=? ORDER BY id", (cid,))
    if p.get("evidence_id"):
        evs = [x for x in evs if x["id"] == p["evidence_id"]] or evs
    for ev in evs[:1] if not p.get("evidence_id") else evs:
        if ev["snapshot_id"] == p["snapshot"]:
            g.execute("UPDATE evidence SET last_confirmed_at=?, evidence_state='live' WHERE id=?", (c.at, ev["id"]))
            continue
        # 오프셋은 스냅샷마다 다르다(계약 2.11). 페이로드에 위치가 없으면 옛 값을 복사하지 않고 NULL로 둔다
        located = ev["selector_kind"] == "text_quote" and p.get("start_cp") is not None
        sel = {"selector_kind": ev["selector_kind"]}
        if ev["selector_kind"] == "jsonpointer":
            sel["json_pointer"] = ev["json_pointer"]
        elif located:
            sel.update(start_cp=p["start_cp"], end_cp=p["end_cp"])
        elif ev["start_cp"] is not None:
            sel.update(start_cp=ev["start_cp"], end_cp=ev["end_cp"])  # 근거 ID를 v1 재생과 같게 둔다. 행의 위치는 NULL이다
        else:
            sel["exact"] = ev["exact"]
        nid = ids.evidence_id(cid, p["snapshot"], sel)
        sn = cur_node(g, p["snapshot"])
        tsha = (jl(sn["props"]) or {}).get("text_sha") if sn else None
        exact, prefix, suffix = (p.get("exact"), p.get("prefix"), p.get("suffix")) if located else (ev["exact"], ev["prefix"], ev["suffix"])
        g.execute("INSERT OR IGNORE INTO evidence(id,claim_id,snapshot_id,text_sha,selector_kind,exact,prefix,suffix,start_cp,"
                  "end_cp,json_pointer,evidence_state,support_check,gate_version,last_confirmed_at,seq) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,'live',?,?,?,?)",
                  (nid, cid, p["snapshot"], tsha, ev["selector_kind"], exact, prefix, suffix, p.get("start_cp") if located else None,
                   p.get("end_cp") if located else None, ev["json_pointer"], ev["support_check"], ev["gate_version"], c.at, c.seq))
    add_change(c, cid, prev["version"], "Claim", prev["sensitivity"])


def _claim_event(c: Ctx, p: dict, status: str, **kw) -> None:
    cid = p["id"]
    prev = cur_node(c.g, cid)
    if prev is None:
        return add_change(c, cid, None, "Claim", 0)
    row = reversion(c, cid, status=status, valid_to=kw.get("valid_to", c.at), set_valid_to=True) or prev
    add_change(c, cid, row["version"], "Claim", row["sensitivity"])


def h_claim_supersede(c: Ctx, p: dict) -> None:
    vt, _ = parse_time(p.get("valid_to"))
    _claim_event(c, p, "superseded", valid_to=vt if vt is not None else c.at)
    edge_new(c, ids.edge_id(p["by"], "SUPERSEDES", p["id"]), p["by"], "SUPERSEDES", p["id"], props={"reason": p.get("reason")} if p.get("reason") else None)


def h_claim_withdraw(c: Ctx, p: dict) -> None:
    _claim_event(c, p, "superseded")


def h_claim_retract(c: Ctx, p: dict) -> None:
    _claim_event(c, p, "dead")


def h_claim_review(c: Ctx, p: dict) -> None:
    g, cid = c.g, p["id"]
    prev = cur_node(g, cid)
    if prev is None:
        return add_change(c, cid, None, "Claim", 0)
    if p.get("support_check"):
        g.execute("UPDATE evidence SET support_check=? WHERE claim_id=?", (p["support_check"], cid))
    row = reversion(c, cid, verification=p["verification"]) or prev
    add_change(c, cid, row["version"], "Claim", row["sensitivity"])


# ---------- 원시, 시계열, 출처

def h_snapshot_captured(c: Ctx, p: dict) -> None:
    g, e = c.g, c.e
    sid, url = p["id"], p["url"]
    did = p.get("document_id") or ids.document_id(url)
    doms = list(p.get("domain") or [])
    if not doms:
        src = cur_node(g, p["source"])
        doms = (jl(src["props"]) or {}).get("domain", []) if src else []
    props = {k: p[k] for k in ("url", "raw_sha", "content_type", "bytes", "fetched_at", "http_status", "etag",
                               "last_modified", "source", "tier") if p.get(k) is not None}
    props["document_id"] = did
    ret = "ttl30" if p.get("tier") == "ttl" else "permanent"
    prev = cur_node(g, sid)
    if prev and prev["props"] == jb(props):
        row = prev
    else:
        row = node_new(c, sid, prev, type="Snapshot", origin=e["origin"], status="active", eff_status="active",
                       sensitivity=0, retention=ret, label=url, props=jb(props), author=e["actor"],
                       valid_from=p.get("fetched_at"), generated_by=e["generated_by"], on_behalf_of=e["on_behalf_of"])
    if cur_node(g, did) is None:
        node_new(c, did, None, type="Document", origin=e["origin"], retention=ret, label=url,
                 props=jb({"url": ids.normalize_url(url)}), author=e["actor"], valid_from=p.get("fetched_at"))
    edge_new(c, ids.edge_id(sid, "SNAPSHOT_OF", did), sid, "SNAPSHOT_OF", did)
    add_domains(g, sid, doms)
    add_domains(g, did, doms)
    add_change(c, sid, row["version"], "Snapshot", 0)


def h_snapshot_text(c: Ctx, p: dict) -> None:
    g, e = c.g, c.e
    sid = p["snapshot"]
    snap = cur_node(g, sid)
    if snap is None:
        return add_change(c, sid, None, "Snapshot", 0)
    props = jl(snap["props"]) or {}
    props.update(text_sha=p["text_sha"], text_format=p["text_format"], paras_sha=p["paras_sha"], extractor=p["extractor"])
    # first_party가 본문을 바꾸면 이 스냅샷은 더 이상 외부 본문이 아니다. 출처는 더 제한적인 쪽으로 올린다
    up = {"origin": "first_party"} if e["origin"] == "first_party" and snap["origin"] != "first_party" else {}
    row = node_new(c, sid, snap, props=jb(props), **up)
    tb, pb = c.obj(p["text_sha"]), c.obj(p["paras_sha"])
    if tb is None or pb is None:  # skip 모드: 없는 객체는 목록에 남고 문단은 건너뛴다
        return add_change(c, sid, row["version"], "Snapshot", 0)
    text = tb.decode("utf-8")
    paras = json.loads(pb)
    did = props.get("document_id") or ids.document_id(props.get("url", sid))
    existing: dict[str, list[int]] = {}
    for s in many(g, "SELECT s.sid, u.sha FROM span s JOIN unit u ON u.rid=s.unit_rid WHERE s.ref_id=? AND s.ref_kind='document' "
                     "AND s.rec_to IS NULL ORDER BY s.sid", (did,)):
        existing.setdefault(s["sha"], []).append(s["sid"])
    src = props.get("source")
    for para in paras:
        sha = para["para_sha"]
        a, b = para["start_cp"], para["end_cp"]
        if existing.get(sha):
            g.execute("UPDATE span SET start_cp=?, end_cp=?, snapshot_id=?, source_id=? WHERE sid=?",
                      (a, b, sid, src, existing[sha].pop(0)))
            continue
        span_open(c, unit_rid=unit_for(c, text[a:b], "para", sha=sha), ref_id=did, ref_kind="document", type="Document",
                  origin=snap["origin"], status="active", eff_status="active", sensitivity=0, start_cp=a, end_cp=b,
                  snapshot_id=sid, source_id=src)
    for sids in existing.values():
        for s in sids:
            g.execute("UPDATE span SET rec_to=? WHERE sid=?", (c.at, s))
    c.cost += len(paras)
    add_change(c, sid, row["version"], "Snapshot", 0)


def h_series_define(c: Ctx, p: dict) -> None:
    g, e = c.g, c.e
    sid = p["id"]
    props = {k: p[k] for k in ("metric", "unit", "subject", "granularity") if p.get(k) is not None}
    prev = cur_node(g, sid)
    add_domains(g, sid, p.get("domain"))
    if prev and prev["props"] == jb(props) and prev["label"] == p["label"]:
        row = prev
    else:
        row = node_new(c, sid, prev, type="Series", origin=e["origin"], label=p["label"], props=jb(props), author=e["actor"])
        close_spans(c, sid)
        span_open(c, unit_rid=unit_for(c, p["label"], "label"), ref_id=sid, ref_kind="node", type="Series",
                  origin=e["origin"], status="active", eff_status="active", sensitivity=0)
    if p.get("subject"):
        edge_new(c, ids.edge_id(sid, "MEASURES", p["subject"]), sid, "MEASURES", p["subject"])
    add_change(c, sid, row["version"], "Series", 0)


def _points(raw: bytes) -> list[dict]:
    t = raw.decode("utf-8").strip()
    if not t:
        return []
    if t.startswith("["):
        return json.loads(t)
    return [json.loads(x) for x in t.splitlines() if x.strip()]


def h_series_batch(c: Ctx, p: dict) -> None:
    g = c.g
    sid = p["series_id"]
    add_domains(g, sid, domains_of(g, p["snapshot"]))
    raw = c.obj(p["points_sha"])
    if raw is not None:
        for pt in _points(raw):
            cur = one(g, "SELECT * FROM series_obs WHERE series_id=? AND period_key=? AND expired_at IS NULL",
                      (sid, pt["period_key"]))
            if cur and cur["value"] == pt["value"] and cur["unit"] == pt.get("unit"):
                g.execute("UPDATE series_obs SET last_seen_at=? WHERE oid=?", (c.at, cur["oid"]))
                continue
            if cur:
                g.execute("UPDATE series_obs SET expired_at=? WHERE oid=?", (c.at, cur["oid"]))
            g.execute("INSERT INTO series_obs(series_id,period_key,period_start,period_end,value,unit,snapshot_id,observed_at,"
                      "last_seen_at,expired_at,seq) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)",
                      (sid, pt["period_key"], pt["period_start"], pt.get("period_end"), pt["value"], pt.get("unit"),
                       p["snapshot"], c.at, c.at, c.seq))
    n = cur_node(g, sid)
    add_change(c, sid, n["version"] if n else None, "Series", 0)


def h_source_registered(c: Ctx, p: dict) -> None:
    props = dict(p.get("props") or {})
    for k in ("class", "domain", "spec_sha"):
        if p.get(k) is not None:
            props[k] = p[k]
    _source(c, p["id"], p.get("label"), props)


def h_source_status(c: Ctx, p: dict) -> None:
    prev = cur_node(c.g, p["id"])
    props = (jl(prev["props"]) if prev else None) or {}
    props["state"] = p["state"]
    if p.get("reason"):
        props["state_reason"] = p["reason"]
    _source(c, p["id"], None, props, link_status=p["state"])


def _source(c: Ctx, sid: str, label, props: dict, link_status=None) -> None:
    g = c.g
    prev = cur_node(g, sid)
    if prev:
        old = jl(prev["props"]) or {}
        props = {**old, **props}
    lab = label or (prev["label"] if prev else sid)
    add_domains(g, sid, props.get("domain"))
    link = link_status if link_status is not None else (prev["link_status"] if prev else None)
    if prev and prev["props"] == jb(props) and prev["label"] == lab and prev["link_status"] == link:
        row = prev
    else:
        row = node_new(c, sid, prev, type="Source", origin=c.e["origin"], label=lab, props=jb(props), author=c.e["actor"],
                       link_status=link)
    add_change(c, sid, row["version"], "Source", 0)


def h_gap(c: Ctx, p: dict) -> None:
    c.g.execute("INSERT INTO gap(source_id,from_at,to_at,reason,seq) VALUES(?,?,?,?,?)",
                (p["source"], p["from_at"], p["to_at"], p["reason"], c.seq))
    add_change(c, p["source"], None, "Source", 0)


def h_verdict(c: Ctx, p: dict) -> None:
    g = c.g
    tgt, status = p["target"], p["status"]
    live = "active" if p["liveness"] == "alive" else p["liveness"]
    prev = cur_node(g, tgt)
    row = prev
    if prev:
        row = node_new(c, tgt, prev, status=status, eff_status=status if not prev["merged_into"] else prev["eff_status"],
                       liveness=live)
        if not prev["merged_into"] and row["eff_status"] != prev["eff_status"]:
            respan(c, tgt, status=status, eff_status=status)
    if p.get("successor"):
        edge_new(c, ids.edge_id(p["successor"], "SUCCESSOR_OF", tgt), p["successor"], "SUCCESSOR_OF", tgt,
                 props={"decided_by": p["decided_by"]})
    # 주어가 병합으로 superseded가 된 경우는 제외한다(읽기가 최종 대상으로 묶는다). event는 영향이 없다.
    if not (prev and prev["merged_into"]):
        for cl in many(g, "SELECT n.id FROM claim c JOIN node n ON n.vid=c.vid WHERE c.subject=? AND n.expired_at IS NULL "
                          "AND c.kind IN ('state','howto') ORDER BY n.id", (tgt,)):
            n = cur_node(g, cl["id"])
            cc = one(g, "SELECT kind FROM claim WHERE vid=?", (n["vid"],))
            want = n["status"] if n["status"] != "active" else (status if status in DEAD else "active")
            if want != n["eff_status"]:
                reversion(c, cl["id"], eff=want)
    add_change(c, tgt, row["version"] if row else None, row["type"] if row else None, row["sensitivity"] if row else 0)


# ---------- 티켓, 스키마, 시스템

def _ticket(c: Ctx, p: dict, status: str, **extra) -> None:
    g = c.g
    tid = p["id"]
    prev = cur_node(g, tid)
    props = (jl(prev["props"]) if prev else None) or {}
    for k in ("reason", "priority", "urls", "requester"):
        if p.get(k) is not None:
            props[k] = p[k]
    props["status"] = status
    if p.get("note"):
        props["note"] = p["note"]
    row = node_new(c, tid, prev, type="Ticket", origin=c.e["origin"], label=p.get("topic") or (prev["label"] if prev else tid),
                   sensitivity=1, props=jb(props), author=c.e["actor"], status="active")
    add_change(c, tid, row["version"], "Ticket", 1)


def h_ticket_open(c, p): _ticket(c, p, "queued")
def h_ticket_update(c, p): _ticket(c, p, p["status"])
def h_ticket_close(c, p): _ticket(c, p, p["status"])


def h_type_defined(c: Ctx, p: dict) -> None:
    c.g.execute("INSERT OR REPLACE INTO type_def(name,kind,version,schema_json,status) VALUES(?,?,?,?,?)",
                (p["name"], p["kind"], p["version"], None if p.get("schema_json") is None else canon_json(p["schema_json"]).decode(),
                 p["status"]))
    add_change(c, p["name"], p["version"], p["kind"], 0)


def h_predicate_defined(c: Ctx, p: dict) -> None:
    add_change(c, p["id"], None, "Predicate", 0)


def h_epoch(c: Ctx, p: dict) -> None:
    c.g.execute("INSERT INTO meta(k,v) VALUES('epoch','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT)")
    add_change(c, None, None, None, 0)


def h_quarantined(c: Ctx, p: dict) -> None:
    if p["seq"] in c.skip:
        c.g.execute("INSERT OR REPLACE INTO quarantine(seq,reason,at) VALUES(?,?,?)", (p["seq"], p["error"], c.at))
    add_change(c, str(p["seq"]), None, None, 0)


def h_released(c: Ctx, p: dict) -> None:
    c.g.execute("DELETE FROM quarantine WHERE seq=?", (p["seq"],))
    c.skip.discard(p["seq"])
    mark_rebuild_required(c)
    add_change(c, str(p["seq"]), None, None, 0)


HANDLERS = {
    "record.put": h_record_put, "record.tombstone": h_record_tombstone, "record.redact": h_record_redact,
    "entity.put": h_entity_put, "entity.alias": h_entity_alias, "entity.merge": h_entity_merge,
    "edge.put": h_edge_put, "edge.expire": h_edge_expire,
    "claim.assert": h_claim_assert, "claim.confirm": h_claim_confirm, "claim.supersede": h_claim_supersede,
    "claim.withdraw": h_claim_withdraw, "claim.retract": h_claim_retract, "claim.review": h_claim_review,
    "snapshot.captured": h_snapshot_captured, "snapshot.text": h_snapshot_text,
    "series.define": h_series_define, "series.batch": h_series_batch,
    "source.registered": h_source_registered, "source.status": h_source_status, "gap.recorded": h_gap,
    "survival.verdict": h_verdict,
    "ticket.open": h_ticket_open, "ticket.update": h_ticket_update, "ticket.close": h_ticket_close,
    "schema.type_defined": h_type_defined, "schema.predicate_defined": h_predicate_defined,
    "schema.epoch_bumped": h_epoch,
    "system.projection_quarantined": h_quarantined, "system.projection_released": h_released,
}
