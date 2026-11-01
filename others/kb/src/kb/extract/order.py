"""L2 큐 꺼내기 순서(리드 판정 2026-11-01). 잔액이 큐 전체보다 적으므로 가치 순으로 쓴다.
1) 도메인 A~F가 G보다 먼저. 2) 같은 층 안에서는 소스를 돌아가며. 3) G는 활성 1차 문서(trust=primary, 피드 아님)가 피드 항목보다 먼저.
4) 같은 URL의 더 새 스냅샷이 있는 스냅샷의 창은 건너뛰고 큐에서 지운다."""
from __future__ import annotations

from kb.core import opsdb
from kb.extract import windows

DOMAINS_AF = frozenset("ABCDEF")
FEED_MARKS = ("rss", "atom")


def _meta(proc, sid: str, cache: dict) -> dict:
    m = cache.get(sid)
    if m is not None:
        return m
    m = {"source": "", "trust": "unknown", "feed": False, "superseded": False}
    try:
        info = proc.snapshot_info(sid)
        ct = str(info.props.get("content_type") or "").lower()
        m.update(source=info.source, trust=info.trust, feed=any(k in ct for k in FEED_MARKS))
        newer = [s for s in proc.gold.snapshots_of_url(info.url)
                 if (s.get("fetched_at") or 0, s["id"]) > (info.props.get("fetched_at") or 0, sid)]
        m["superseded"] = bool(info.url) and bool(newer)
    except Exception:  # noqa: BLE001  메타를 못 얻으면 건너뛰지 않고 가장 낮은 층에 둔다
        pass
    cache[sid] = m
    return m


def _tier(domain: str | None, m: dict) -> int:
    if domain in DOMAINS_AF:
        return 0
    if domain == "G" and m["trust"] == "primary" and not m["feed"]:
        return 1
    return 2


def pick(rows: list, n: int) -> list:
    """rows: (row, tier, source) 목록(우선순위 내림차순, 오래된 순으로 정렬됨). 층 순서, 층 안에서 (도메인, 소스) 순환."""
    picked: list = []
    for t in (0, 1, 2):
        buckets: dict = {}
        for r, tier, src in rows:
            if tier == t:
                buckets.setdefault((r[3] or "", src), []).append(r)
        keys = sorted(buckets)
        while len(picked) < n and any(buckets[k] for k in keys):
            for k in keys:
                if buckets[k] and len(picked) < n:
                    picked.append(buckets[k].pop(0))
        if len(picked) >= n:
            break
    return picked


def take(proc, c, kind: str, n: int, cache: dict, lease_ms: int | None = None) -> list[dict]:
    lease = lease_ms or opsdb.LEASE_MS
    now = opsdb._now()
    c.execute("BEGIN IMMEDIATE")
    try:
        raw = c.execute("SELECT id, kind, ref, domain, priority, attempts FROM queue "
                        "WHERE kind=? AND state IN ('queued','taken') AND (next_at IS NULL OR next_at<=?) "
                        "ORDER BY priority DESC, enqueued_at, id", (kind, now)).fetchall()
        rows, dead = [], []
        for r in raw:
            m = _meta(proc, windows.parse_ref(r[2])[0], cache)
            if m["superseded"]:
                dead.append(r[0])
            else:
                rows.append((r, _tier(r[3], m), m["source"]))
        for i in dead:
            c.execute("DELETE FROM queue WHERE id=?", (i,))
        picked = pick(rows, n)
        for r in picked:
            c.execute("UPDATE queue SET state='taken', attempts=attempts+1, next_at=? WHERE id=?", (now + lease, r[0]))
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return [{"id": r[0], "kind": r[1], "ref": r[2], "domain": r[3] or None, "priority": r[4], "attempts": r[5] + 1}
            for r in picked]
