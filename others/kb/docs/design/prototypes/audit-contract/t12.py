"""계약 4.5 예시 노드와 시점 사건 주장이 ADR 7.4 술어(기본값 현재)를 통과하는가."""
import sqlite3, datetime as dt
ms = lambda s: int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
c = sqlite3.connect(":memory:")
c.execute("CREATE TABLE node(id TEXT, status TEXT, valid_from INT, valid_to INT, recorded_at INT, expired_at INT)")
c.execute("INSERT INTO node VALUES('e:feature/claude-code-ultraplan','dead',NULL,?,?,NULL)", (ms("2026-08-02T00:00:00Z"), ms("2026-10-31T01:02:03Z")))
c.execute("INSERT INTO node VALUES('c-event-release','active',?,?,?,NULL)", (ms("2025-05-22T00:00:00Z"), ms("2025-05-23T00:00:00Z"), ms("2026-10-31T01:02:03Z")))
P = "coalesce(valid_from, -9000000000000000000) <= :v AND (valid_to IS NULL OR valid_to > :v) AND recorded_at <= :o AND (expired_at IS NULL OR expired_at > :o)"
now = ms("2026-10-31T12:00:00Z")
print("기본 술어 통과:", c.execute(f"SELECT id FROM node WHERE {P}", {"v": now, "o": now}).fetchall())
print("관측축만:", c.execute("SELECT id,status FROM node WHERE recorded_at<=:o AND (expired_at IS NULL OR expired_at>:o)", {"o": now}).fetchall())
