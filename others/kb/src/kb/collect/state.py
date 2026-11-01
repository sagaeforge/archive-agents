"""수집 상태(ops.db). source_state, url_state, fetch_log, circuit, robots_cache, dlq는 kb.core.opsdb의 표다.
ops.db를 잃으면 레지스트리에서 다시 만들어지고 전 소스가 만기가 될 뿐이다."""
from __future__ import annotations

import json

from kb.collect import clock
from kb.core import opsdb

H = 3600 * 1000
D = 24 * H
FETCH_LOG_KEEP_MS = 30 * D
CIRCUIT_FIRST_MS = 1 * H
CIRCUIT_REPEAT_MS = 7 * D
DLQ_STEPS_MS = (1 * H, 1 * D, 7 * D)
BACKOFF_BASE_MS = 10 * 60 * 1000
BACKOFF_MAX_MS = 48 * H
# 네트워크를 쓰지 않은 결과. 호스트 간격과 시간당 예산 계산에서 뺀다
NO_NETWORK = ("host_denied", "circuit_open", "robots_denied", "budget_exceeded", "policy_skip", "disabled")

UNIT_FIELDS = {
    "source_state": ("next_check_at", "last_ok_at", "fail_count", "state", "etag", "last_modified", "last_sha", "shape"),
    "url_state": ("next_check_at", "last_ok_at", "fail_count", "state", "etag", "last_modified", "last_sha", "discovered_from"),
}


def backoff_ms(fail_count: int) -> int:
    return min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** max(0, fail_count - 1)))


class State:
    def __init__(self, conn=None):
        self._own = conn is None
        self.c = conn or opsdb.connect()

    def close(self) -> None:
        if self._own:
            self.c.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    # ---- fetch_log
    def log(self, source_id, host: str, url: str, outcome: str, status=None, nbytes=None, ms=None) -> None:
        self.c.execute("INSERT INTO fetch_log(at, source_id, host, url, status, outcome, bytes, ms) VALUES(?,?,?,?,?,?,?,?)",
                       (clock.now_ms(), source_id, host, url, status, outcome, nbytes, ms))

    def last_network_at(self, host: str) -> int | None:
        q = ",".join("?" * len(NO_NETWORK))
        r = self.c.execute(f"SELECT max(at) FROM fetch_log WHERE host=? AND outcome NOT IN ({q})", (host, *NO_NETWORK)).fetchone()
        return r[0]

    def hour_count(self, host: str) -> int:
        q = ",".join("?" * len(NO_NETWORK))
        return self.c.execute(f"SELECT count(*) FROM fetch_log WHERE host=? AND at>? AND outcome NOT IN ({q})",
                              (host, clock.now_ms() - H, *NO_NETWORK)).fetchone()[0]

    def prune_log(self) -> int:
        return self.c.execute("DELETE FROM fetch_log WHERE at<?", (clock.now_ms() - FETCH_LOG_KEEP_MS,)).rowcount

    # ---- source_state / url_state
    def get(self, source_id: str, url: str | None = None) -> dict | None:
        if url is None:
            cols = UNIT_FIELDS["source_state"]
            r = self.c.execute(f"SELECT {','.join(cols)} FROM source_state WHERE source_id=?", (source_id,)).fetchone()
        else:
            cols = UNIT_FIELDS["url_state"]
            r = self.c.execute(f"SELECT {','.join(cols)} FROM url_state WHERE source_id=? AND url=?", (source_id, url)).fetchone()
        return dict(zip(cols, r)) if r else None

    def put(self, source_id: str, url: str | None = None, **f) -> None:
        tbl = "source_state" if url is None else "url_state"
        bad = set(f) - set(UNIT_FIELDS[tbl])
        if bad:
            raise ValueError(f"{tbl}에 없는 열: {sorted(bad)}")
        keys = ["source_id"] + (["url"] if url is not None else [])
        vals = [source_id] + ([url] if url is not None else [])
        row = self.get(source_id, url)
        if row is None:
            f.setdefault("state", "new")
            f.setdefault("fail_count", 0)
        else:
            # 기존 행 갱신: INSERT 쪽 NOT NULL 검사를 통과하도록 기존 값을 채운다(충돌 시 같은 값으로 덮인다)
            for k in ("state", "fail_count"):
                if k not in f:
                    f[k] = row[k]
        cols = keys + list(f)
        sets = ", ".join(f"{k}=excluded.{k}" for k in f) or "source_id=source_id"
        self.c.execute(f"INSERT INTO {tbl}({','.join(cols)}) VALUES({','.join('?' * len(cols))}) "
                       f"ON CONFLICT({','.join(keys)}) DO UPDATE SET {sets}", vals + list(f.values()))

    def list_urls(self, source_id: str) -> list[dict]:
        cols = UNIT_FIELDS["url_state"]
        return [dict(zip(("url",) + cols, r)) for r in
                self.c.execute(f"SELECT url,{','.join(cols)} FROM url_state WHERE source_id=? ORDER BY url", (source_id,))]

    # ---- 서킷
    def circuit_until(self, host: str) -> int | None:
        r = self.c.execute("SELECT state, until_at FROM circuit WHERE host=?", (host,)).fetchone()
        if r and r[0] == "open" and r[1] and r[1] > clock.now_ms():
            return r[1]
        return None

    def trip(self, host: str, reason: str) -> int:
        """서킷을 연다. 최소 1시간, 직전 서킷이 7일 안이면 7일. until_at을 돌려준다."""
        now = clock.now_ms()
        r = self.c.execute("SELECT opened_at, trips FROM circuit WHERE host=?", (host,)).fetchone()
        repeat = bool(r and r[0] and now - r[0] < CIRCUIT_REPEAT_MS)
        trips = (r[1] + 1) if repeat else 1
        until = now + (CIRCUIT_REPEAT_MS if repeat else CIRCUIT_FIRST_MS)
        self.c.execute("INSERT INTO circuit(host, state, opened_at, until_at, reason, trips) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(host) DO UPDATE SET state='open', opened_at=excluded.opened_at, "
                       "until_at=excluded.until_at, reason=excluded.reason, trips=excluded.trips",
                       (host, "open", now, until, reason[:200], trips))
        return until

    # ---- robots 캐시
    def robots_get(self, host: str) -> tuple | None:
        r = self.c.execute("SELECT fetched_at, status, body FROM robots_cache WHERE host=?", (host,)).fetchone()
        return tuple(r) if r else None

    def robots_put(self, host: str, status: int, body: str) -> None:
        self.c.execute("INSERT INTO robots_cache(host, fetched_at, status, body) VALUES(?,?,?,?) "
                       "ON CONFLICT(host) DO UPDATE SET fetched_at=excluded.fetched_at, status=excluded.status, body=excluded.body",
                       (host, clock.now_ms(), status, body))

    # ---- page 큐(ADR 10.4): priority가 작은 쪽이 먼저(A~F 0, G 1), 같은 priority 안에서는 domain 순환
    def page_put(self, ref: str, domain: str | None, priority: int) -> bool:
        cur = self.c.execute("INSERT OR IGNORE INTO queue(kind, ref, domain, priority, enqueued_at, next_at, state) "
                             "VALUES('page',?,?,?,?,NULL,'queued')", (ref, domain, priority, clock.now_ms()))
        return cur.rowcount == 1

    def page_take(self, n: int, lease_ms: int = H) -> list[dict]:
        now = clock.now_ms()
        self.c.execute("BEGIN IMMEDIATE")
        try:
            rows = self.c.execute("SELECT id, ref, domain, priority FROM queue WHERE kind='page' AND state IN ('queued','taken') "
                                  "AND (next_at IS NULL OR next_at<=?) ORDER BY priority ASC, enqueued_at, id", (now,)).fetchall()
            picked: list = []
            tiers: dict[int, dict[str, list]] = {}
            for r in rows:
                tiers.setdefault(r[3], {}).setdefault(r[2] or "", []).append(r)
            for pr in sorted(tiers):
                b = tiers[pr]
                while len(picked) < n and any(b.values()):
                    for k in list(b):
                        if b[k] and len(picked) < n:
                            picked.append(b[k].pop(0))
                if len(picked) >= n:
                    break
            for r in picked:
                self.c.execute("UPDATE queue SET state='taken', attempts=attempts+1, next_at=? WHERE id=?", (now + lease_ms, r[0]))
            self.c.execute("COMMIT")
        except BaseException:
            if self.c.in_transaction:
                self.c.execute("ROLLBACK")
            raise
        return [{"id": r[0], "ref": r[1], "domain": r[2] or None, "priority": r[3]} for r in picked]

    def page_done(self, ref: str) -> None:
        self.c.execute("DELETE FROM queue WHERE kind='page' AND ref=?", (ref,))

    def page_reclaim(self) -> int:
        return self.c.execute("UPDATE queue SET state='queued', next_at=NULL WHERE kind='page' AND state='taken'").rowcount

    def page_count(self) -> int:
        return self.c.execute("SELECT count(*) FROM queue WHERE kind='page'").fetchone()[0]

    # ---- tick_state 키-값
    def kv_get(self, k: str, default=None):
        r = self.c.execute("SELECT v FROM tick_state WHERE k=?", (k,)).fetchone()
        return r[0] if r else default

    def kv_set(self, k: str, v) -> None:
        self.c.execute("INSERT INTO tick_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))

    def kv_json(self, k: str, default=None):
        v = self.kv_get(k)
        return json.loads(v) if v else default

    # ---- DLQ
    def dlq_put(self, kind: str, ref: str, stage: str, error: str, payload_sha: str | None = None) -> int:
        """같은 (kind, ref)가 있으면 시도 수를 올리고 다음 재시도를 1시간, 1일, 7일 뒤로 잡는다. 그 뒤는 사람 대기열(next_at NULL)."""
        r = self.c.execute("SELECT id, attempts FROM dlq WHERE kind=? AND ref=? AND stage=?", (kind, ref, stage)).fetchone()
        n = (r[1] + 1) if r else 1
        nxt = clock.now_ms() + DLQ_STEPS_MS[n - 1] if n <= len(DLQ_STEPS_MS) else None
        if r:
            self.c.execute("UPDATE dlq SET error=?, attempts=?, next_at=?, payload_sha=coalesce(?, payload_sha) WHERE id=?",
                           (error[:500], n, nxt, payload_sha, r[0]))
            return r[0]
        cur = self.c.execute("INSERT INTO dlq(kind, ref, stage, error, attempts, next_at, payload_sha) VALUES(?,?,?,?,?,?,?)",
                             (kind, ref, stage, error[:500], n, nxt, payload_sha))
        return cur.lastrowid

    def dlq_list(self, kind: str | None = None) -> list[dict]:
        sql = "SELECT id, kind, ref, stage, error, attempts, next_at, payload_sha FROM dlq"
        args: tuple = ()
        if kind:
            sql += " WHERE kind=?"
            args = (kind,)
        cols = ("id", "kind", "ref", "stage", "error", "attempts", "next_at", "payload_sha")
        return [dict(zip(cols, r)) for r in self.c.execute(sql + " ORDER BY id", args)]
