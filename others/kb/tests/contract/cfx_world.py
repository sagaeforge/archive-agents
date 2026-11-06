"""계약 fixture의 원천: 합성 원장과 CAS 객체를 결정적으로 만든다(계약 9장).

합성 데이터다. 실제 사실이 아니다. 이름, 수치, URL은 모두 지어낸 것이고 *.example.test 도메인만 쓴다.
같은 코드가 항상 같은 바이트를 낸다(시각, 이벤트 ID, idem_key 고정). 생성은 gen_fixtures.py가 하고,
test_fixture_roundtrip.py가 저장된 파일과 이 코드의 출력이 같은지도 확인한다.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata

T0 = 1_800_000_000_000  # 2027-01-15T08:00:00Z
H = 3_600_000
D = 86_400_000
T1, T2, T3, T4, T5 = (T0 + k * H for k in (10, 20, 30, 40, 50))
NOW_MS = T0 + 15 * D  # 요청을 부르는 동안 고정하는 시계

BASE_URL = "https://docs.example.test"

RAW_MD = "# Commands\n\n| /widget | 예시 명령 | 합성 |\n".encode()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canon(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


class World:
    def __init__(self):
        self.ev: list[dict] = []
        self.cas: dict[str, bytes] = {}
        self.t = T0

    # ------------------------------------------------------------ 저수준
    def blob(self, data: bytes) -> str:
        s = sha(data)
        self.cas[s] = data
        return s

    def add(self, kind, payload, subject=None, *, origin="external", actor="collector:fixture", at=None, **kw):
        n = len(self.ev) + 1
        if at is None:
            self.t += 1000
        else:
            assert at >= self.t, (kind, subject, at, self.t)
            self.t = at
        e = {"kind": kind, "actor": actor, "origin": origin, "idem_key": f"fx:{n:04d}", "payload": payload, "subject": subject,
             "at": self.t, "event_id": f"01000000-0000-7000-8000-{n:012d}", "v": 1}
        e.update(kw)
        self.ev.append(e)
        return e

    # ------------------------------------------------------------ 도우미
    def doc(self, paras):
        text, plist = "", []
        for t in paras:
            if text:
                text += "\n\n"
            a = len(text)
            text += t
            plist.append({"para_sha": sha(t.encode()), "start_cp": a, "end_cp": len(text), "heading_path": [], "table_header": None})
        return self.blob(text.encode()), self.blob(canon(plist)), text

    def snap(self, sid, url, source, paras, raw=None, **extra):
        tsha, psha, text = self.doc(paras)
        p = {"id": sid, "document_id": "d-" + sid, "source": source, "url": url, "raw_sha": raw or sha(sid.encode()),
             "fetched_at": T0, "content_type": "text/plain", "http_status": 200}
        p.update(extra)
        self.add("snapshot.captured", p, sid)
        self.add("snapshot.text", {"snapshot": sid, "text_sha": tsha, "text_format": "text", "extractor": "fixture@1", "paras_sha": psha}, sid)
        return text

    def entity(self, eid, label=None, at=None, **kw):
        p = {"id": eid, "type": eid.split(":")[1].capitalize(), "label": label or eid}
        p.update(kw)
        return self.add("entity.put", p, eid, at=at)

    def claim(self, cid, subject, statement, kind="state", snap="n-1", at=None, exact=None, sel=None, method="llm", **kw):
        ev = {"snapshot": snap, "selector_kind": "text_quote", "exact": exact or statement}
        ev.update(sel or {})
        p = {"id": cid, "subject": subject, "statement": statement, "kind": kind, "stance": "stated", "method": method,
             "verification": "quote_found" if method == "llm" else "parser_derived", "evidence": [ev]}
        p.update(kw)
        return self.add("claim.assert", p, cid, at=at)

    def record(self, rid, title, sens="internal", body="본문", at=None, rtype="Note", actor="user:sagae", **kw):
        p = {"id": rid, "type": rtype, "title": title, "sensitivity": sens, "body": body}
        p.update(kw)
        extra = {"on_behalf_of": "user:sagae"} if actor.startswith("agent:") else {}
        return self.add("record.put", p, rid, origin="first_party", actor=actor, at=at, **extra)

    def verdict(self, target, status, liveness, at=None, **kw):
        p = {"target": target, "unit": "tool", "liveness": liveness, "status": status, "signals": [{"id": "M05"}], "decided_by": "agent:fixture"}
        p.update(kw)
        return self.add("survival.verdict", p, target, at=at)

    def points(self, rows, base):
        return self.blob(b"\n".join(json.dumps({"period_key": k, "period_start": base + i * D, "period_end": base + (i + 1) * D,
                                                "value": v, "unit": "rank"}, sort_keys=True).encode() for i, (k, v) in enumerate(rows)))


REPO_TYPE = {"name": "Repo", "kind": "node", "version": 1, "status": "active", "schema_json": {"type": "object", "properties": {
    "stars": {"type": "integer", "x-kb-sortable": True}, "lang": {"type": "string"}, "ratio": {"type": "number", "x-kb-sortable": True},
    "tags": {"type": "array", "items": {"type": "string"}}, "created": {"type": "string", "format": "date-time"},
    "flag": {"type": "boolean"}, "hidden": {"type": "string", "x-kb-filterable": False}}}}

REPO_ROWS = [  # id, label, props(stars가 같은 b, e, f는 동률)
    ("a", "Hooks", {"stars": 10, "lang": "go", "ratio": "0.5", "tags": ["x", "y"], "created": "2027-01-01T00:00:00Z", "flag": True}),
    ("b", "hook-lib", {"stars": 9, "lang": "go", "ratio": "1.25", "tags": ["y"], "created": "2027-02-01", "flag": False}),
    ("c", "a:b:c", {"stars": 100, "lang": "Rust", "tags": [], "created": "2026-12-31T23:59:59Z"}),
    ("d", "a,b", {"lang": "go", "hidden": "s"}),
    ("e", "Éa", {"stars": 9, "ratio": 2}),
    ("f", "éa", {"stars": 9}),
    ("g", "zeta", {}),
]

EMOJI_PRE = "🎬 업로드 규칙: 🎉🎉 "
EMOJI_QUOTE = "매주 한 편 올린다"
NFD_QUOTE = unicodedata.normalize("NFD", "한국어 자막은 필수다")


def build() -> World:
    w = World()
    # ---------------------------------------------------------------- 출처, 타입
    w.add("source.registered", {"id": "src:a", "label": "합성 출처 A"}, "src:a")
    w.add("source.registered", {"id": "src:b", "label": "합성 출처 B"}, "src:b")
    w.add("schema.type_defined", REPO_TYPE)

    # ---------------------------------------------------------------- 스냅샷
    raw_sha = w.blob(RAW_MD)
    t1 = w.snap("n-1", f"{BASE_URL}/widget", "src:a",
                ["합성 도구 알파는 위젯을 지원한다.", "달 기능은 채널에 열린다.", "시청 시간 기준은 4,000시간이다.", "history 기능은 위젯을 지원한다"],
                domain=["F"])
    t2 = w.snap("n-2", f"{BASE_URL}/policy", "src:a", ["기준은 시간으로 정해진다.", "두 번째 문단이다."], domain=["E"])
    emoji_text = EMOJI_PRE + EMOJI_QUOTE + "."
    w.snap("n-emoji", f"{BASE_URL}/emoji", "src:b", [emoji_text])
    nfd_text = "자막 규칙: " + NFD_QUOTE + "."
    w.snap("n-nfd", f"{BASE_URL}/nfd", "src:b", [nfd_text])
    w.snap("n-raw", f"{BASE_URL}/commands.md", "src:a", ["# Commands", "| /widget | 예시 명령 | 합성 |"], raw=raw_sha, content_type="text/markdown",
           bytes=len(RAW_MD))
    assert "history 기능은 위젯을 지원한다" in t1 and "두 번째 문단이다." in t2

    # ---------------------------------------------------------------- 엔티티와 기본 주장, 엣지
    for eid, lab in (("e:product:p", "합성 제품 P"), ("e:feature:history", "기록 기능"), ("e:tool:x", "도구 X"), ("e:tool:alpha", "도구 알파"),
                     ("e:policy:ypp", "합성 정책 YPP"), ("e:policy:future", "합성 정책 미래"), ("e:policy:retro", "합성 정책 소급"),
                     ("e:video:v", "합성 영상")):
        w.entity(eid, lab, domain=["F"] if eid.startswith("e:tool") else ["E"])
    w.claim("c-1", "e:feature:history", "history 기능은 위젯을 지원한다", predicate="supports", value="위젯", domain=["F"])
    w.claim("c-ko-1", "e:tool:alpha", "합성 도구 알파는 위젯을 지원한다.", predicate="supports", value="위젯")
    w.claim("c-ko-2", "e:tool:alpha", "달 기능은 채널에 열린다.", predicate="moon_feature", value="채널")
    w.claim("c-ko-3", "e:policy:ypp", "시청 시간 기준은 4,000시간이다.", predicate="threshold_hours", value="4000", unit="hour")
    w.add("edge.put", {"id": "r-01", "src": "e:feature:history", "rtype": "PART_OF", "dst": "e:product:p"}, "r-01")
    w.add("edge.put", {"id": "r-02", "src": "e:tool:x", "rtype": "USES", "dst": "e:product:p"}, "r-02")
    # 평행 엣지: 같은 양끝, 다른 관계
    w.add("edge.put", {"id": "r-par-1", "src": "e:tool:x", "rtype": "USES", "dst": "e:tool:alpha"}, "r-par-1")
    w.add("edge.put", {"id": "r-par-2", "src": "e:tool:x", "rtype": "DEPENDS_ON", "dst": "e:tool:alpha"}, "r-par-2")

    # ---------------------------------------------------------------- 표 문법용 Repo 노드(stars 동률 포함)
    for i, lab, props in REPO_ROWS:
        w.entity(f"e:repo:{i}", lab, props=props, at=None)

    # ---------------------------------------------------------------- 시계열: 재공시와 공백
    base = T0 - 10 * D
    w.add("series.define", {"id": "s:rank", "label": "합성 순위", "metric": "chart_rank", "unit": "rank", "subject": "e:video:v"}, "s:rank")
    w.add("series.batch", {"series_id": "s:rank", "snapshot": "n-2", "parser": "fixture@1", "count": 3,
                           "points_sha": w.points([("d1", "5"), ("d2", "4"), ("d3", "3")], base)}, "s:rank")
    w.add("gap.recorded", {"source": "src:a", "from_at": base + 3 * D, "to_at": base + 5 * D, "reason": "machine_off"}, "src:a")

    # ---------------------------------------------------------------- 티켓
    w.add("ticket.open", {"id": "t-1", "topic": "위젯 조사", "reason": "합성 필요", "priority": 2}, "t-1")
    w.add("ticket.open", {"id": "t-2", "topic": "달 조사", "reason": "합성 필요"}, "t-2")
    w.add("ticket.close", {"id": "t-1", "status": "done"}, "t-1")

    # ---------------------------------------------------------------- 인용 위치: 이모지, NFD
    start = emoji_text.index(EMOJI_QUOTE)
    assert len(emoji_text[:start].encode("utf-16-le")) // 2 != start  # 코드포인트와 UTF-16 오프셋이 다르다
    w.entity("e:policy:upload", "합성 업로드 규칙")
    w.claim("c-emoji", "e:policy:upload", "매주 한 편 올린다", snap="n-emoji", exact=EMOJI_QUOTE,
            sel={"start_cp": start, "end_cp": start + len(EMOJI_QUOTE)}, predicate="cadence", value="weekly")
    s2 = nfd_text.index(NFD_QUOTE)
    w.entity("e:policy:caption", "합성 자막 규칙")
    w.claim("c-nfd", "e:policy:caption", "한국어 자막은 필수다", snap="n-nfd", exact=NFD_QUOTE,
            sel={"start_cp": s2, "end_cp": s2 + len(NFD_QUOTE)}, predicate="caption", value="required")

    # ---------------------------------------------------------------- 병합 연쇄
    w.entity("e:tool:ma", "병합 A")
    w.entity("e:tool:mb", "병합 B")
    w.entity("e:tool:mc", "병합 C")
    w.claim("c-ma", "e:tool:ma", "ma는 위젯을 지원한다", predicate="supports", value="위젯")
    w.claim("c-mb", "e:tool:mb", "mb는 달을 지원한다", predicate="supports", value="달")
    w.add("edge.put", {"id": "r-ma-x", "src": "e:tool:ma", "rtype": "USES", "dst": "e:tool:x"}, "r-ma-x")
    w.add("entity.merge", {"from": "e:tool:ma", "into": "e:tool:mb"})
    w.add("entity.merge", {"from": "e:tool:mb", "into": "e:tool:mc"})

    # ---------------------------------------------------------------- first_party 레코드
    w.record("f-1", "공개 메모", "internal", body="# 공개 메모\n\n- 항목 하나\n- 위젯 [도구 X](e:tool:x)\n", body_format="markdown",
             links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}])
    w.record("f-priv", "비공개 메모", "private", body="private 본문")
    w.record("f-sec", "비밀 메모", "secret", body="SECRET-BODY-XYZ")
    w.record("f-agent", "에이전트 메모", "internal", body="에이전트가 쓴 위젯 메모", actor="agent:s-fixture", rtype="Decision",
             props={"status": "accepted"})
    w.record("f-raise", "상향 메모", "internal", body="내부 본문", links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}])

    # ---------------------------------------------------------------- 시간축이 어긋나는 사례(T1 이후)
    w.entity("e:tool:rename", "옛이름", at=T1, props={"v": 1})
    w.entity("e:tool:dead", "죽은 도구", at=T1)
    w.entity("e:tool:old", "옛 도구", at=T1)
    w.entity("e:tool:new", "새 도구", at=T1)
    w.entity("e:tool:revived", "되살아난 도구", at=T1)
    w.claim("c-dead-state", "e:tool:dead", "dead는 위젯을 지원한다", "state", predicate="supports", value="위젯", at=T1)
    w.claim("c-dead-event", "e:tool:dead", "dead는 2026년에 출시됐다", "event", valid={"from": "2026-01-01"}, at=T1)
    w.claim("c-old-state", "e:tool:old", "old는 달을 지원한다", "state", predicate="supports", value="달", at=T1)
    w.claim("c-rev-state", "e:tool:revived", "revived는 위젯을 지원한다", "state", predicate="supports", value="위젯", at=T1)
    # 소급 정정: 유효 시점은 같고 관측 시점에 따라 값이 다르다
    mk = lambda val, at: w.claim("c-retro", "e:policy:retro", f"기준은 {val}시간이다.", "state", snap="n-2", exact="기준은 시간으로 정해진다.",
                                 predicate="entry_hours", value=val, unit="hour", valid={"from": "2024-06-01"}, at=at)
    mk("4000", T1)
    # 대체 체인 3세대
    ch = lambda cid, val, vf, vt, at: w.claim(cid, "e:policy:ypp", f"기준은 {val}시간이다.", "state", snap="n-2", exact="기준은 시간으로 정해진다.",
                                              predicate="chain_hours", slot="chain", value=val, unit="hour", method="deterministic",
                                              valid={"from": vf, **({"to": vt} if vt else {})}, at=at)
    ch("c-chain-1", "4000", "2022-01-01", None, T1)
    w.entity("e:tool:rename", "새이름", at=T2, props={"v": 2})
    w.verdict("e:tool:revived", "dead", "removed", at=T2)
    ch("c-chain-1", "4000", "2022-01-01", "2024-01-01", T2)
    ch("c-chain-2", "3000", "2024-01-01", None, T2)
    w.add("claim.supersede", {"id": "c-chain-1", "by": "c-chain-2", "valid_to": "2024-01-01"}, "c-chain-1", at=T2)
    ch("c-chain-2", "3000", "2024-01-01", "2026-01-01", T3)
    ch("c-chain-3", "2000", "2026-01-01", None, T3)
    w.add("claim.supersede", {"id": "c-chain-2", "by": "c-chain-3", "valid_to": "2026-01-01"}, "c-chain-2", at=T3)
    mk("3000", T3)  # 소급 정정(같은 id, 같은 유효 구간, 다른 값)
    # 미래 발효 대체: 효력일(2027-03-01) 전에는 두 주장이 모두 active
    fut = lambda cid, val, vf, vt, at: w.claim(cid, "e:policy:future", f"기준은 {val}시간이다.", "state", snap="n-2", exact="기준은 시간으로 정해진다.",
                                               predicate="future_hours", slot="f", value=val, unit="hour",
                                               valid={"from": vf, **({"to": vt} if vt else {})}, at=at)
    fut("c-fut-old", "3000", "2024-01-01", None, T3)
    fut("c-fut-new", "2000", "2027-03-01", None, T3)
    fut("c-fut-old", "3000", "2024-01-01", "2027-03-01", T3)
    # 주어 판정
    w.verdict("e:tool:dead", "dead", "removed", at=T3)
    w.verdict("e:tool:old", "superseded", "superseded", successor="e:tool:new", at=T3)
    w.verdict("e:tool:revived", "active", "revived", at=T3)
    # 민감도 상향: internal -> private
    w.record("f-raise", "상향 메모", "private", body="비공개 본문", links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}], at=T3)
    # 재공시: 같은 구간의 값을 새 배치가 다시 알린다
    w.add("series.batch", {"series_id": "s:rank", "snapshot": "n-2", "parser": "fixture@1", "count": 1,
                           "points_sha": w.points([("d2", "2")], base + D)}, "s:rank", at=T3)
    # first_party 버전 2
    w.record("f-1", "공개 메모", "internal", body="# 공개 메모\n\n- 항목 하나\n- 항목 둘\n- 위젯 [도구 X](e:tool:x)\n", body_format="markdown",
             links=[{"rtype": "LINKS_TO", "dst": "e:tool:x"}], at=T3 + H)

    # ---------------------------------------------------------------- 에포크 전환, 그 뒤에 export를 게시한다
    w.add("schema.epoch_bumped", {"reason": "fixture restore"}, origin="system", actor="system:fixture", at=T4)
    w.exported_after = len(w.ev)
    # ---------------------------------------------------------------- export 뒤 꼬리
    w.entity("e:tool:tail", "꼬리 도구", at=T5)
    w.claim("c-tail", "e:tool:tail", "tail은 위젯을 지원한다", predicate="supports", value="위젯", at=T5 + H)
    w.record("f-tail", "꼬리 메모", "internal", body="export 뒤에 쓴 메모", at=T5 + 2 * H)
    return w


def ledger_lines(w: World) -> bytes:
    return b"".join(canon(e) + b"\n" for e in w.ev)
