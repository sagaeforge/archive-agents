"""큐 항목 -> 6,000자 이하 창. 인접 문단을 묶고 후보(별칭 조회 + FTS 상위 30, __new__ 포함)를 붙인다."""
from __future__ import annotations

import hashlib

from kb.extract import cache, settings
from kb.extract.types import Window
from kb.gate.context import alias_in, norm

MAX_CANDIDATES = 30


def ref_of(snapshot: str, para_sha: str, start_cp: int) -> str:
    return f"{snapshot}|{para_sha}|{start_cp}"


def parse_ref(ref: str) -> tuple:
    s, p, st = ref.split("|")
    return s, p, int(st)


def _is_public(con, eid: str) -> bool:
    r = con.execute("SELECT sensitivity, origin FROM node WHERE id=? AND expired_at IS NULL", (eid,)).fetchone() if con else None
    return bool(r) and r[0] == 0 and r[1] != "first_party"


def candidates_for(proc, text: str, limit: int = MAX_CANDIDATES, *, public: bool = True) -> list:
    """등록 엔티티 중 창 본문에 별칭이 나오는 것 + FTS 상위. 닫힌 enum의 재료다.
    public이면 후보가 외부 프롬프트로 나가므로 민감 엔티티를 뺀다. 민감 범위(sLLM 전용)만 False로 부른다."""
    out: dict = {}
    hay = norm(text)
    gold = proc.gold
    try:
        for a, eid in gold.all_aliases().items():
            if eid not in out and alias_in(a, hay):
                n = gold.node(eid)
                if n and (not public or _is_public(gold.conn(), eid)):
                    out[eid] = {"id": eid, "label": n["label"], "aliases": [a]}
                if len(out) >= limit:
                    break
    except Exception:  # noqa: BLE001 gold가 없어도 창은 만든다
        pass
    if len(out) < limit:
        try:
            from kb.core.text import query_tokens
            toks = sorted(query_tokens(text), key=len, reverse=True)[:12]
            con = gold.conn()
            if toks and con is not None:
                q = " OR ".join('"' + t.replace('"', "") + '"' for t in toks)
                rows = con.execute("SELECT s.subject, count(*) c FROM fts f JOIN span s ON s.sid=f.rowid WHERE fts MATCH ? "
                                   "AND s.rec_to IS NULL AND s.subject IS NOT NULL AND s.sensitivity=0 AND s.origin<>'first_party' GROUP BY s.subject ORDER BY c DESC LIMIT ?",
                                   (q, limit)).fetchall()
                for sid, _ in rows:
                    if sid not in out and len(out) < limit:
                        n = gold.node(sid)
                        if n and n["type"] not in ("Claim", "Snapshot", "Document", "Record") \
                                and (not public or _is_public(con, sid)):     # 주어의 현재 라벨도 외부로 나간다
                            out[sid] = {"id": sid, "label": n["label"], "aliases": []}
        except Exception:  # noqa: BLE001
            pass
    return list(out.values())[:limit]


def build(proc, items: list, max_chars: int | None = None) -> tuple:
    """items: queue_take 결과. 반환 (창 목록, 처리 못 한 항목(requeue), 캐시로 건너뛴 항목)."""
    limit = int(max_chars or settings.get("window_chars", 6000))
    by_snap: dict = {}
    for it in items:
        s, p, st = parse_ref(it["ref"])
        by_snap.setdefault(s, []).append((st, p, it))
    all_sha = [p for lst in by_snap.values() for _, p, _ in lst]
    done = cache.done_keys(all_sha)
    cached = [it for lst in by_snap.values() for _, p, it in lst if p in done]
    wins, leftover = [], []
    for sid, lst in by_snap.items():
        lst.sort(key=lambda x: x[0])
        info = proc.text_of(proc.snapshot_info(sid))
        cur, size = [], 0
        spans_cur: list = []
        seen = set()
        def flush():
            nonlocal cur, size, spans_cur
            if cur:
                txt = "\n\n".join(t for _, t, _ in cur)
                wid = f"{sid}#{cur[0][0][:8]}"
                wsha = hashlib.sha256(txt.encode()).hexdigest()
                w = Window(wid, sid, txt, [(p, t) for p, t, _ in cur], [], info.title, info.publisher or "",
                           "", info.url)
                w.items = [it for _, _, it in cur]
                w.sha = wsha
                w.spans = list(spans_cur)
                wins.append(w)
            cur, size, spans_cur = [], 0, []
        for st, p, it in lst:
            if p in done or p in seen:
                if p in seen:
                    cached.append(it)
                continue
            seen.add(p)
            para = next((x for x in info.paras if x.start_cp == st and x.para_sha == p), None)
            if para is None:
                leftover.append(it)
                continue
            t = info.text[para.start_cp:para.end_cp]
            if cur and size + len(t) + 2 > limit:
                flush()
            cur.append((p, t, it))
            spans_cur.append((para.start_cp, para.end_cp))
            size += len(t) + 2
        flush()
    for w in wins:
        w.candidates = candidates_for(proc, w.text)
    return wins, leftover, cached
