"""적재 계약 kb-ingest/1 처리기(ADR 9장). validate와 submit이 같은 코드를 지나고, 쓰기는 write=True일 때만 한다.
항목은 파일 순서대로 처리하고 ref는 앞에서 정의된 것만 가리킨다."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from kb.core import cas, config, ids, paths
from kb.core.canon import canon_json, sha256_hex
from kb.gate import GATE_VERSION, GateCtx, check_claim, support
from kb.gate.liveness import CODE as LIVE_CODE
from kb.gate.liveness import is_g_unit, liveness_stance
from kb.gate.model import G_UNIT_TYPES
from kb.gate.textmatch import QuoteError, locate
from kb.ingest import bundle, rules
from kb.ingest.store import REUSE_MS, Gold, SnapInfo, load_text, now_ms
from kb.write.errors import IdemConflict, WriteRejected

VERDICT = {"active": "alive", "renamed": "renamed", "scheduled_removal": "scheduled_removal", "removed": "removed",
           "superseded": "superseded", "stale_suspect": "stale_suspect", "revived": "revived",
           "deprecated": "deprecated", "partial": "partial"}
STATUS = {"removed": "dead", "superseded": "superseded"}
ADHOC = "src:adhoc"
_GONE = object()


class ItemError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


@dataclass
class Outcome:
    result: str = "accepted"          # accepted | needs_review | held | rejected
    code: str | None = None
    detail: str | None = None
    would_be: dict | None = None
    events: list = field(default_factory=list)
    audit: bool = False               # events가 거부 기록(extract.rejected)이다. 결과는 rejected로 남는다
    before: list = field(default_factory=list)  # 쓰기 전 준비(CAS 객체. 투영이 읽는다)
    after: list = field(default_factory=list)   # 쓰기 성공 뒤 부수 작업(큐 적재 등)
    undo: list = field(default_factory=list)    # 이 항목이 묶음 상태에 남긴 변경. 거부되면 되돌린다
    record: tuple | None = None       # (record dict, idem_key): first_party 창구


def _h(o) -> str:
    return sha256_hex(canon_json(o))[:12]


def _types() -> dict:
    d = paths.share_dir() / "schemas" / "types"
    nodes, edges = {}, {}
    if d.is_dir():
        for p in d.glob("*.json"):
            if p.stem.startswith("edge-"):
                edges[p.stem[5:].upper()] = p.stem[5:]
            else:
                nodes[p.stem.lower()] = p.stem
    return {"nodes": nodes, "edges": edges}


class Processor:
    def __init__(self, header: dict, *, fetch: bool = True, write: bool = False, profile: str | None = None,
                 now: int | None = None, windows: dict | None = None):
        self.windows = windows or {}      # 스냅샷 ID -> 모델이 본 원문 구간. 대역 밖 입력이다(묶음 안의 값은 믿지 않는다)
        self.h, self.fetch, self.write, self.profile = header, fetch, write, profile
        self.producer = header["producer"]
        self.domain = list(header.get("domain") or [])
        self.now = now or now_ms()
        self.gold = Gold()
        self.refs: dict = {}              # ref -> {"kind", "id", ...}
        self.snaps: dict = {}             # snapshot ID -> SnapInfo
        self.ents: dict = {}              # 이 묶음이 정의한 엔티티 ID -> dict(type,label,aliases,domain,props,liveness)
        self.claim_ids: dict = {}         # 이 묶음이 만든 주장 ID
        self._txn: list = []              # 처리 중인 항목의 묶음 상태 변경 기록
        self._sources = None
        self._types = _types()
        self._primary_hosts = None
        self.new_events = 0
        self.replayed = 0

    # ------------------------------------------------------------ 공통
    def _put(self, store: dict, key, val) -> None:
        """묶음 상태를 바꾼다. 항목이 거부되면 rollback이 되돌려 뒤 항목이 없는 엔티티를 있다고 읽지 않게 한다."""
        self._txn.append((store, key, store.get(key, _GONE)))
        store[key] = val

    @staticmethod
    def rollback(txn: list) -> None:
        for store, key, old in reversed(txn):
            if old is _GONE:
                store.pop(key, None)
            else:
                store[key] = old
        txn.clear()

    @property
    def sources(self) -> dict:
        if self._sources is None:
            from kb.collect import registry
            try:
                self._sources = {s.id: s for s in registry.load_registry(validate=False)}
            except Exception:  # noqa: BLE001 레지스트리가 깨져도 검증은 src:adhoc로 돈다
                self._sources = {}
            self._sources[ADHOC] = registry.adhoc_source()
        return self._sources

    def primary_hosts(self) -> set:
        if self._primary_hosts is None:
            self._primary_hosts = {h for s in self.sources.values() if s.enabled and s.policy.get("trust") == "primary"
                                   for h in s.hosts()}
        return self._primary_hosts

    def ev(self, kind, subject, key, payload, origin="external") -> dict:
        return {"kind": kind, "actor": self.producer, "origin": origin, "subject": subject, "idem_key": key, "payload": payload}

    def entity_id(self, ref_or_id) -> str:
        """ref 또는 공개 ID -> 엔티티 ID. 풀리지 않으면 E_REF."""
        if not isinstance(ref_or_id, str) or not ref_or_id:
            raise ItemError("E_REF", "참조가 비었다")
        r = self.refs.get(ref_or_id)
        if r is not None:
            if r["kind"] != "entity":
                raise ItemError("E_REF", f"{ref_or_id}는 엔티티가 아니다")
            return r["id"]
        if ref_or_id.startswith("e:"):
            try:
                ids.check_public_id(ref_or_id)
            except ValueError:
                raise ItemError("E_SCHEMA", f"공개 ID 형식 위반: {ref_or_id}") from None
            if ref_or_id in self.ents or self.gold.node(ref_or_id):
                return ref_or_id
            raise ItemError("E_REF", f"엔티티가 없다: {ref_or_id}")
        raise ItemError("E_REF", f"풀리지 않는 참조: {ref_or_id}")

    def entity_info(self, eid: str) -> dict | None:
        if eid in self.ents:
            return self.ents[eid]
        n = self.gold.node(eid)
        if not n:
            return None
        return {"type": n["type"], "label": n["label"], "aliases": self.gold.forms(eid), "domain": self.gold.domains(eid),
                "props": n["props"], "liveness": n["liveness"], "recorded_at": n["recorded_at"]}

    # ------------------------------------------------------------ 스냅샷
    def snapshot_info(self, ref_or_id: str) -> SnapInfo:
        r = self.refs.get(ref_or_id)
        sid = r["id"] if r and r["kind"] == "snapshot" else ref_or_id
        if r and r["kind"] != "snapshot":
            raise ItemError("E_REF", f"{ref_or_id}는 스냅샷이 아니다")
        if sid in self.snaps:
            return self.snaps[sid]
        n = self.gold.node(sid)
        if not n or n["type"] != "Snapshot":
            raise ItemError("E_REF", f"스냅샷이 없다: {ref_or_id}")
        return self._mk_snap(sid, n["props"])

    def _mk_snap(self, sid: str, props: dict) -> SnapInfo:
        src = self.sources.get(props.get("source") or "")
        publisher = None
        if src is not None and src.id != ADHOC:
            publisher = src.raw.get("publisher") or src.name or None
        info = SnapInfo(id=sid, url=props.get("url") or "", source=props.get("source") or "",
                        trust=(src.policy.get("trust") if src is not None else "unknown") or "unknown",
                        publisher=publisher, props=props)
        self.snaps[sid] = info
        return info

    def _source_names(self, info: SnapInfo) -> tuple:
        """주어 문맥에 쓰는 소스 이름·발행처·레지스트리 별칭."""
        src = self.sources.get(info.source)
        if src is None or src.id == ADHOC:
            return (info.publisher,) if info.publisher else ()
        out = [src.name, src.raw.get("publisher"), info.publisher, *(src.raw.get("aliases") or [])]
        return tuple(x for x in dict.fromkeys(out) if x)

    def text_of(self, info: SnapInfo) -> SnapInfo:
        try:
            return load_text(info, self.sources, write=self.write)
        except (cas.CasError, OSError, KeyError, ValueError, UnicodeDecodeError, IdemConflict, WriteRejected) as e:
            raise ItemError("E_FETCH", f"스냅샷 본문을 만들지 못함: {type(e).__name__}: {str(e)[:100]}") from None

    def _item_snapshot(self, it: dict) -> Outcome:
        source = it["source"]
        if "snapshot" in it:
            sid = it["snapshot"]
            n = self.gold.node(sid)
            if not n or n["type"] != "Snapshot":
                raise ItemError("E_REF", f"스냅샷이 없다: {sid}")
            info = self._mk_snap(sid, n["props"])
            self.refs[it.get("ref") or sid] = {"kind": "snapshot", "id": sid}
            return Outcome(would_be={"snapshot": sid, "url": info.url, "source": info.source})
        url = it["url"]
        try:
            u = urlsplit(url)
            host = u.hostname
        except ValueError:                                  # http://[bad 같은 URL이 묶음 전체를 멈추면 안 된다
            raise ItemError("E_POLICY", f"URL을 해석할 수 없다: {url[:80]}") from None
        if u.scheme not in ("http", "https") or not host:
            raise ItemError("E_POLICY", f"http(s) URL이 아니다: {url[:80]}")
        from kb.collect import hostpolicy, registry
        why = hostpolicy.denied_reason(u.hostname)
        if why:
            raise ItemError("E_POLICY", f"호스트 정책: {why}")
        src = self.sources.get(source)
        if src is None:
            raise ItemError("E_POLICY", f"미등록 소스: {source}. 미등록 URL은 {ADHOC}로만 받는다")
        if source != ADHOC and not src.owns_url(url):
            raise ItemError("E_POLICY", f"{source}의 URL이 아니다. 미등록 URL은 {ADHOC}로만 받는다")
        dec = src.url_decision(url) if source != ADHOC else None
        if dec is not None and not config.decision_ok(int(dec)):
            raise ItemError("E_POLICY", f"결정 {dec} 미승인")
        ok, reason = registry.runnable(src)
        if not ok:
            raise ItemError("E_POLICY", f"소스 정책: {reason}")
        sid, props = self._existing_recent(url, source), None
        if sid is None:
            if not self.fetch:
                raise ItemError("E_FETCH", "--no-fetch: 24시간 안의 기존 스냅샷이 없다")
            from kb.collect import capturer
            from kb.collect.errors import CollectError
            try:
                r = capturer.capture(src, url, conditional=source != ADHOC, reuse_s=REUSE_MS / 1000)
            except CollectError as e:
                raise ItemError("E_POLICY" if getattr(e, "code", "") == "E_POLICY" else "E_FETCH", str(e)[:160]) from None
            if not r.ok:
                raise ItemError(r.code or "E_FETCH", f"{r.outcome}: {r.error or ''}"[:160])
            sid = r.snapshot
        n = self.gold.node(sid)
        if not n:
            raise ItemError("E_FETCH", f"스냅샷 {sid}이 gold에 아직 없다")
        info = self._mk_snap(sid, n["props"])
        self.refs[it.get("ref") or sid] = {"kind": "snapshot", "id": sid}
        return Outcome(would_be={"snapshot": sid, "url": url, "source": info.source, "trust": info.trust})

    def _existing_recent(self, url: str, source: str) -> str | None:
        for p in self.gold.snapshots_of_url(url):
            if p.get("source") == source and self.now - int(p.get("fetched_at") or 0) <= REUSE_MS:
                return p["id"]
        return None

    # ------------------------------------------------------------ liveness 공통
    def _signals(self, target: str, unit: str, signals: list) -> list:
        """신호 검증. 반환: 이벤트용 신호 목록(스냅샷 ID로 풀린)."""
        if not signals:
            raise ItemError("E_NO_EVIDENCE", "liveness 신호가 없다")
        tinfo = self.entity_info(target) or {}
        out = []
        for s in signals:
            try:
                info = self.snapshot_info(s["snapshot"])
            except ItemError as e:
                raise ItemError("E_REF", e.detail) from None
            if info.trust != "primary":
                if info.source != ADHOC or not rules.official(unit, tinfo.get("props") or {}, tinfo.get("label") or "",
                                                              info.url, self.primary_hosts()):
                    raise ItemError("E_LIVENESS_SOURCE", f"신호 {s['id']}의 출처({info.source}, trust={info.trust})는 대상의 1차 출처가 아니다")
            sig = {"id": s["id"], "snapshot": info.id}
            if s.get("quote"):
                self.text_of(info)
                try:
                    loc = locate(info.text, s["quote"], s.get("prefix", ""), s.get("suffix", ""))
                except QuoteError as e:
                    raise ItemError(e.code, f"신호 {s['id']}: {e.detail}") from None
                sig["quote"] = info.text[loc.start:loc.end]
            out.append(sig)
        return out

    def _liveness_block(self, target: str, unit: str, lv: dict) -> dict:
        state = lv["state"]
        succ = None
        if state == "superseded":
            if not lv.get("successor"):
                raise ItemError("E_SUCCESSOR_REQUIRED", "superseded는 successor가 필요하다. 후속이 불명이면 removed로 둔다")
            succ = self.entity_id(lv["successor"])
        elif lv.get("successor"):
            succ = self.entity_id(lv["successor"])
        sigs = self._signals(target, unit, lv.get("signals") or [])
        blk = {"state": state, "liveness": state, "status": STATUS.get(state, "active"), "unit": unit, "signals": sigs,
               "decided_by": lv["decided_by"]}
        if succ:
            blk["successor"] = succ
        return blk

    def _liveness_events(self, target: str, blk: dict, entity_payload: dict | None) -> list:
        """entity.put(liveness 포함)와 survival.verdict."""
        evs = []
        k = _h([target, blk])
        if entity_payload is not None:
            evs.append(self.ev("entity.put", target, f"ingest:ent:{target}:{_h(entity_payload)}", entity_payload))
        vp = {"target": target, "unit": blk["unit"], "liveness": VERDICT[blk["state"]], "status": blk["status"],
              "signals": blk["signals"], "decided_by": blk["decided_by"]}
        if blk.get("successor"):
            vp["successor"] = blk["successor"]
        evs.append(self.ev("survival.verdict", target, f"ingest:live:{target}:{k}", vp))
        return evs

    # ------------------------------------------------------------ 항목
    def handle(self, line: int, it: dict) -> Outcome:
        kind = it.get("item")
        if kind == "bundle":
            return Outcome("rejected", "E_SCHEMA", "머리 줄은 첫 줄에만 둔다")
        if kind not in bundle.ITEM_KINDS:
            return Outcome("rejected", "E_SCHEMA", f"알 수 없는 item: {kind!r}")
        err = bundle.schema_error(it, kind)
        if err:
            return Outcome("rejected", "E_SCHEMA", err)
        ref = it.get("ref")
        if ref and ref in self.refs:
            return Outcome("rejected", "E_REF", f"ref 중복: {ref}")
        self._txn = []
        try:
            out = getattr(self, "_i_" + kind)(it, line)
            if out.result != "rejected":
                self._lint(out.events)
        except ItemError as e:
            out = Outcome("rejected", e.code, e.detail)
        if out.result == "rejected":
            self.rollback(self._txn)
            return out
        if kind != "snapshot" and ref and ref not in self.refs:
            self._put(self.refs, ref, {"kind": kind, "id": (out.would_be or {}).get("id")})
        out.undo = self._txn
        return out

    @staticmethod
    def _lint(events: list) -> None:
        """commit과 같은 R6 검사. validate와 submit의 판정이 갈리지 않게 항목 끝에서 먼저 돈다."""
        from kb.write import policy
        try:
            policy.lint_events(events)
        except WriteRejected as e:
            raise ItemError("E_R6_SCORE", str(e)[:160]) from None

    def _i_snapshot(self, it, line):
        return self._item_snapshot(it)

    def _canon_type(self, t: str) -> str:
        c = self._types["nodes"].get(t.lower())
        if not c:
            raise ItemError("E_SCHEMA", f"알 수 없는 type: {t}")
        return c

    def _i_entity(self, it, line):
        typ = self._canon_type(it["type"])
        key = it["key"]
        pre, sep, slug = key.partition(":")
        if sep:
            if pre.lower() != typ.lower():
                raise ItemError("E_SCHEMA", f"key의 타입({pre})이 type({typ})과 다르다")
        else:
            slug = key
        try:
            nid = ids.entity_id(typ, slug)
        except ValueError as e:
            raise ItemError("E_SCHEMA", str(e)) from None
        dom = list(it.get("domain") or self.domain)
        old = self.entity_info(nid)
        props = dict((old or {}).get("props") or {})
        props.update(it.get("props") or {})
        label = old["label"] if old else it["label"]
        lv = it.get("liveness")
        blk = None
        if lv is not None:
            # 신호의 공식 위치 규칙이 대상의 props를 보므로 먼저 임시로 등록한다. 거부되면 되돌린다
            self._put(self.ents, nid, {"type": typ, "label": label, "aliases": [label, *(it.get("aliases") or [])],
                                       "domain": dom, "props": props, "liveness": None, "recorded_at": self.now})
            blk = self._liveness_block(nid, lv.get("unit") or typ.lower(), lv)
        elif is_g_unit(typ, dom) and not (old and old.get("liveness")):
            raise ItemError("E_LIVENESS_REQUIRED", f"G 단위({typ}) 엔티티는 liveness가 필요하다")
        payload = {"id": nid, "type": old["type"] if old else typ, "label": label, "props": props}
        if it.get("aliases"):
            payload["aliases"] = list(it["aliases"])
        if dom:
            payload["domain"] = dom
        if it.get("lang"):
            payload["lang"] = it["lang"]
        if blk:
            payload["liveness"] = blk
        aliases = [label, *(it.get("aliases") or []), it["label"]]
        self._put(self.ents, nid, {"type": payload["type"], "label": label,
                                   "aliases": aliases + ((old or {}).get("aliases") or []), "domain": dom, "props": props,
                                   "liveness": blk["state"] if blk else (old or {}).get("liveness"),
                                   "recorded_at": self.now})
        self._put(self.refs, it.get("ref") or nid, {"kind": "entity", "id": nid})
        evs = self._liveness_events(nid, blk, payload) if blk else [self.ev("entity.put", nid, f"ingest:ent:{nid}:{_h(payload)}", payload)]
        return Outcome(would_be={"id": nid}, events=evs)

    def _i_liveness(self, it, line):
        tid = self.entity_id(it["target"])
        info = self.entity_info(tid) or {}
        blk = self._liveness_block(tid, it["unit"], {"state": it["state"], "signals": it.get("signals"),
                                                     "decided_by": it["decided_by"], "successor": it.get("successor")})
        self._put(self.ents, tid, {**info, "liveness": blk["state"], "recorded_at": self.now})
        return Outcome(would_be={"id": tid, "state": blk["state"], "status": blk["status"]},
                       events=self._liveness_events(tid, blk, None))

    def _evidence(self, ev: dict):
        """근거 {snapshot, quote}를 검증하고 (SnapInfo, Loc, 선택자 dict)을 돌려준다."""
        info = self.text_of(self.snapshot_info(ev["snapshot"]))
        try:
            loc = locate(info.text, ev["quote"], ev.get("prefix", ""), ev.get("suffix", ""))
        except QuoteError as e:
            raise ItemError(e.code, e.detail) from None
        return info, loc

    def _i_edge(self, it, line):
        src, dst = self.entity_id_or_node(it["src"]), self.entity_id_or_node(it["dst"])
        rt = it["rtype"].upper()
        if rt not in self._types["edges"]:
            raise ItemError("E_SCHEMA", f"알 수 없는 rtype: {it['rtype']}")
        props = dict(it.get("props") or {})
        user = self.producer.startswith("user:")
        origin = "external"
        if it.get("evidence"):
            info, loc = self._evidence(it["evidence"])
            props["evidence"] = {"snapshot": info.id, "start_cp": loc.start, "end_cp": loc.end,
                                 "exact": info.text[loc.start:loc.end]}
        elif not user:
            raise ItemError("E_NO_EVIDENCE", "외부 출처 엣지는 evidence가 필요하다")
        else:
            origin = "first_party"
        eid = ids.edge_id(src, rt, dst)
        p = {"id": eid, "src": src, "rtype": rt, "dst": dst}
        if props:
            p["props"] = props
        out = Outcome(would_be={"id": eid}, events=[self.ev("edge.put", src, f"ingest:edge:{eid}:{_h(p)}", p, origin)])
        if origin == "first_party" and not self.write:      # submit에서는 commit이 보류를 알려 준다
            from kb.write.fpgate import is_open
            if not is_open():
                out.result, out.code, out.detail = "held", "H_FP_CLOSED", "first_party 개방 전"
        return out

    def entity_id_or_node(self, x: str) -> str:
        """엣지 끝점: ref, 엔티티 ID, 또는 gold에 있는 임의 노드 ID(주장·스냅샷 포함)."""
        r = self.refs.get(x)
        if r is not None:
            if not r.get("id"):
                raise ItemError("E_REF", f"{x}는 ID를 갖지 않는다")
            return r["id"]
        if x in self.ents or x in self.claim_ids or self.gold.node(x):
            return x
        raise ItemError("E_REF", f"풀리지 않는 참조: {x}")

    def _i_series(self, it, line):
        key = it["key"]
        try:
            sid = ids.series_id(key[2:] if key.startswith("s:") else key)
        except ValueError as e:
            raise ItemError("E_SCHEMA", str(e)) from None
        from kb.parse import adapters
        if adapters.get(it["parser"]) is None:
            raise ItemError("E_POLICY", f"결정적 파서만 받는다. 등록되지 않은 파서: {it['parser']}")
        info = self.snapshot_info(it["snapshot"])
        pts = it["points"]
        if len({p["period"] for p in pts}) != len(pts):
            raise ItemError("E_SCHEMA", "points의 period가 겹친다")
        from kb.project.apply import parse_time
        norm_pts = []
        for p_ in pts:
            try:
                start, prec = parse_time(p_["period"])
            except ValueError:
                start = None
            if start is None:
                raise ItemError("E_SCHEMA", f"period를 시각으로 읽을 수 없다: {p_['period']!r}")
            pt = {"period_key": p_["period"], "period_start": start, "value": str(p_["value"])}
            if prec == "day":
                pt["period_end"] = start + 86400_000
            if it.get("unit"):
                pt["unit"] = it["unit"]
            norm_pts.append(pt)
        pts = norm_pts
        nd = b"\n".join(canon_json(p_) for p_ in pts) + b"\n"
        sha = sha256_hex(nd)
        d = {"id": sid, "label": it.get("label") or key, "metric": it["metric"]}
        if it.get("unit"):
            d["unit"] = it["unit"]
        dom = list(it.get("domain") or self.domain)
        if dom:
            d["domain"] = dom
        b = {"series_id": sid, "snapshot": info.id, "parser": it["parser"], "points_sha": sha, "count": len(pts)}
        out = Outcome(would_be={"id": sid, "points": len(pts)}, events=[
            self.ev("series.define", sid, f"series.define:{sid}:{_h(d)}", d),
            self.ev("series.batch", sid, f"ingest:series.batch:{sid}:{info.id}:{it['parser']}:{sha[:12]}", b)])
        if self.write:
            out.before.append(lambda: cas.put(nd))
        return out

    def _i_record(self, it, line):
        if not self.producer.startswith("user:") or self.profile == "collector":
            raise ItemError("E_POLICY", "record는 producer=user:* 묶음에서만 받는다(에이전트, collector 프로필 불가)")
        rec = {k: v for k, v in it.items() if k not in ("item", "ref", "authored_at")}
        key = f"ingest:{self.h['batch_id']}:{it.get('ref') or line}"
        from kb.write import record as _rec
        from kb.write.fpgate import is_open
        if not self.write:
            try:
                _rec._check_shape(rec)
                rid = rec.get("id") or _rec.derive_id(key)
                _rec.build_payload(rec, rid, [], scan=True)
            except WriteRejected as e:
                raise ItemError("E_POLICY" if e.code in ("secret_detected", "policy_r6") else "E_SCHEMA", str(e)[:160]) from None
            held = not is_open()
            return Outcome("held" if held else "accepted", "H_FP_CLOSED" if held else None,
                           "first_party 개방 전" if held else None, would_be={"id": rec.get("id") or _rec.derive_id(key)})
        return Outcome(record=(rec, key), would_be={"id": rec.get("id") or _rec.derive_id(key)})

    # ------------------------------------------------------------ 주장
    def _liveness_fn(self, subject: str):
        def f(subj: str):
            ent = self.ents.get(subj)
            if ent is not None:
                if ent.get("liveness"):
                    return None
                return liveness_stance(subj, con=self.gold.conn(), domains=ent.get("domain"), node_type=ent.get("type"),
                                       now_ms=self.now, enqueue=self.write)
            return liveness_stance(subj, con=self.gold.conn(), now_ms=self.now, enqueue=self.write)
        return f

    def _subject(self, it: dict):
        """(subject_id, forms, new_entity_payload | None)."""
        s = it["subject"]
        if s != "__new__":
            sid = self.entity_id(s)
            return sid, None
        sn = it.get("subject_new")
        if not sn:
            raise ItemError("E_SCHEMA", "subject=__new__에는 subject_new가 필요하다")
        typ = self._canon_type(sn.get("type") or "Concept")
        from kb.parse.model import slugify
        nid = ids.entity_id(typ, slugify(sn["label"]))
        return nid, sn

    def _i_claim(self, it, line):
        kind, method = it["kind"], it["method"]
        valid = dict(it.get("valid") or {})
        if kind == "event" and not (valid.get("from") or it.get("changed_on")):
            raise ItemError("E_EVENT_TIME", "kind=event는 valid.from 또는 changed_on이 필요하다")
        if method == "deterministic" and not it.get("predicate"):
            raise ItemError("E_SCHEMA", "method=deterministic은 predicate가 필요하다")
        from kb.project.apply import parse_time
        for fld, val in (("valid.from", valid.get("from")), ("valid.to", valid.get("to")),
                         ("changed_on", it.get("changed_on"))):
            if val in (None, ""):
                continue
            try:
                ok = parse_time(val)[0] is not None
            except (ValueError, TypeError, OverflowError):
                ok = False
            if not ok:
                raise ItemError("E_SCHEMA", f"{fld}를 시각으로 읽을 수 없다: {val!r}")
        sid, sn = self._subject(it)
        info = self.text_of(self.snapshot_info(it["evidence"]["snapshot"]))
        ev = it["evidence"]
        # 1단계 R6 선검사(점수, 기회, 추천 계열 속성)
        probe = {"predicate": it.get("predicate"), "stance": it["stance"], "qualifiers": it.get("qualifiers"),
                 "props": it.get("props")}
        try:
            from kb.write import policy
            policy.lint_event({"kind": "claim.assert", "origin": "external", "payload": probe})
        except WriteRejected as e:
            raise ItemError("E_R6_SCORE", str(e)[:160]) from None
        # 별칭: 등록 엔티티 또는 __new__의 문단에 나오는 값
        ent_events = []
        existing = self.entity_info(sid)
        new_aliases = None
        pre_loc = None
        try:
            pre_loc = locate(info.text, ev["quote"], ev.get("prefix", ""), ev.get("suffix", ""),
                             self.windows.get(info.id))
        except QuoteError:
            pass
        if existing is not None:
            forms = [existing["label"], *existing["aliases"]]
        else:
            forms = []
        if sn is not None and existing is None:
            from kb.gate import context
            from kb.gate.quote import _attr, _para_for
            para = _para_for(info.paras, pre_loc.start) if pre_loc else None
            ptxt = info.text[_attr(para, "start_cp"):_attr(para, "end_cp")] if para is not None else ""
            hay = context.build_hay(info.text[pre_loc.start:pre_loc.end] if pre_loc else "", ptxt,
                                    _attr(para, "table_header"), _attr(para, "heading_path"), info.title,
                                    self._source_names(info))
            cand = [sn["label"], *(sn.get("aliases") or [])]
            new_aliases = [a for a in dict.fromkeys(cand) if context.alias_in(a, hay)]
            forms = new_aliases
            typ = self._canon_type(sn.get("type") or "Concept")
            dom = list(it.get("domain") or self.domain)
            ep = {"id": sid, "type": typ, "label": sn["label"], "props": {"provisional": True}}
            if new_aliases:
                ep["aliases"] = new_aliases
            if dom:
                ep["domain"] = dom
            ent_events = [self.ev("entity.put", sid, f"ingest:ent:{sid}:{_h(ep)}", ep)]
            self._put(self.ents, sid, {"type": typ, "label": sn["label"], "aliases": new_aliases or [], "domain": dom,
                                       "props": ep["props"], "liveness": None, "recorded_at": self.now})
        elif existing is None:
            raise ItemError("E_REF", f"엔티티가 없다: {sid}")
        known = dict(self.gold.all_aliases())
        for eid, e in self.ents.items():
            for a in e.get("aliases") or []:
                from kb.gate.context import norm
                if len(norm(a)) >= 2:
                    known.setdefault(norm(a), eid)
        ctx = GateCtx(subject=sid, subject_aliases=tuple(forms), known_aliases=known, doc_title=info.title,
                      publisher=info.publisher, source_names=self._source_names(info), liveness=self._liveness_fn(sid))
        res = check_claim({"statement": it["statement"], "kind": kind, "stance": it["stance"], "speaker": it.get("speaker"),
                           "quote": ev["quote"], "prefix": ev.get("prefix", ""), "suffix": ev.get("suffix", "")},
                          info.text, info.paras, ctx, self.windows.get(info.id))
        if res.rejected:
            out = Outcome("rejected", res.code, res.detail)
            if self.write:
                cj = {"item": it, "line": line}
                sha = sha256_hex(canon_json(cj))
                out.audit = True
                out.events = [self.ev("extract.rejected", None, f"ingest:rej:{sha[:16]}:{res.code}",
                                      {"window_sha": sha, "claim_sha": sha, "code": res.code,
                                       "reason": ("격리: 내용을 싣지 않는다" if res.quarantine else (res.detail or ""))[:200]})]
            return out
        pred = it.get("predicate")
        from kb.ingest import vocab
        known_pred = pred is None or vocab.predicate_known(pred)
        qual = it.get("qualifiers") or {}
        if method == "deterministic":
            period = valid.get("from") or it.get("changed_on") if kind == "event" else None
            cid = ids.claim_id_det(sid, pred, qual, it.get("value"), period)
        else:
            cid = ids.claim_id_llm(sid, ev["quote"])
        if not valid.get("from") and it.get("changed_on"):
            valid["from"] = it["changed_on"]
            valid.setdefault("precision", "day")
        text = info.text
        a, b = res.start_cp, res.end_cp
        sel = {"snapshot": info.id, "selector_kind": "text_quote", "exact": res.exact, "start_cp": a, "end_cp": b,
               "prefix": ev.get("prefix") or text[max(0, a - 24):a], "suffix": ev.get("suffix") or text[b:b + 24],
               "text_sha": info.text_sha, "gate_version": GATE_VERSION}
        payload = {"id": cid, "subject": sid, "predicate": pred if known_pred else None, "statement": it["statement"],
                   "kind": kind, "stance": res.stance, "method": method, "verification": res.verification,
                   "extractor": it.get("extractor") or f"ingest:{self.h['batch_id']}", "evidence": [sel]}
        if res.speaker:
            payload["speaker"] = res.speaker
        for k in ("value", "unit", "object"):
            if it.get(k) is not None:
                payload[k] = it[k]
        obj = payload.get("object")
        if isinstance(obj, str) and (obj.startswith("e:") or obj in self.refs):
            payload["object"] = self.entity_id(obj)
        if qual:
            payload["qualifiers"] = qual
        if valid:
            payload["valid"] = valid
        # 항목에 domain이 없으면 머리와 근거 스냅샷 도메인의 합집합을 쓴다. 좁은 머리가 다중 도메인 소스를 깎지 않게 한다
        dom = list(it.get("domain") or sorted({*self.domain, *self.gold.domains(info.id)}))
        if dom:
            payload["domain"] = dom
        if method == "deterministic":
            from kb.parse.conflicts import slot_of
            payload["slot"] = slot_of(sid, pred, qual)
        out = Outcome(would_be={"id": cid, "verification": res.verification, "status": "active"})
        if res.result == "needs_review":
            out.result, out.code, out.detail = "needs_review", res.code, res.detail
            out.would_be["codes"] = res.codes
        # 같은 ID면 새 주장을 만들지 않는다. 주어 엔티티와 이 묶음의 엣지는 기존 주장에도 붙인다
        existing_claim = cid in self.claim_ids or self.gold.node(cid) is not None
        evs = list(ent_events)
        if existing_claim:
            out.would_be["existing"] = True
        else:
            self._put(self.claim_ids, cid, True)
            evs.append(self.ev("claim.assert", sid, f"ingest:claim:{cid}", payload))
        if self.h.get("ticket") and res.result == "accepted":
            eid = ids.edge_id(cid, "ANSWERS", self.h["ticket"])
            p = {"id": eid, "src": cid, "rtype": "ANSWERS", "dst": self.h["ticket"], "props": {"batch": self.h["batch_id"]}}
            evs.append(self.ev("edge.put", cid, f"ingest:edge:{eid}:{_h(p)}", p))
        for d in it.get("depends_on") or []:
            did = self.entity_id(d)
            eid = ids.edge_id(cid, "DEPENDS_ON", did)
            evs.append(self.ev("edge.put", cid, f"ingest:edge:{eid}",
                               {"id": eid, "src": cid, "rtype": "DEPENDS_ON", "dst": did, "claim_id": cid}))
        out.events = evs
        if self.write and not existing_claim:
            if not known_pred and pred:
                out.after.append(lambda p=pred: vocab.candidate(p))
            out.after.append(lambda c=cid: support.enqueue(c, res))
        return out
