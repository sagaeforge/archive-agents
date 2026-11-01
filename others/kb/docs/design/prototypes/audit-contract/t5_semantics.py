"""ADR 7.2 DDL 일부와 ADR 7.4 술어로 계약 의미를 재현한다. 합성 값이고 지식 데이터가 아니다."""
import sqlite3, datetime as dt, random, sys

def ms(s):
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return int(d.timestamp() * 1000)

c = sqlite3.connect(":memory:")
c.executescript("""
CREATE TABLE node(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL, type TEXT NOT NULL,
  origin TEXT NOT NULL, status TEXT NOT NULL, sensitivity INT NOT NULL, label TEXT NOT NULL,
  merged_into TEXT, value TEXT,
  valid_from INT, valid_to INT, recorded_at INT NOT NULL, expired_at INT, seq INT NOT NULL, UNIQUE(id, version));
""")

PRED = """coalesce(valid_from, -9000000000000000000) <= :v AND (valid_to IS NULL OR valid_to > :v)
AND recorded_at <= :o AND (expired_at IS NULL OR expired_at > :o)"""


def q(v, o, extra="1=1"):
    sql = f"SELECT id, version, status, value, sensitivity FROM node WHERE {PRED} AND {extra} ORDER BY id, version"
    return c.execute(sql, {"v": ms(v), "o": ms(o)}).fetchall()


print("=== A. 계약 4.7 예시 데이터에 '기본값 = 현재' 두 축 적용")
c.execute("INSERT INTO node VALUES(1,'c-old',1,'Claim','external','superseded',0,'4000','', '4000',?,?,?,?,10)",
          (ms("2024-06-01T00:00:00Z"), ms("2027-02-01T00:00:00Z"), ms("2026-10-31T01:00:00Z"), ms("2026-11-15T00:00:00Z")))
c.execute("INSERT INTO node VALUES(2,'c-new',1,'Claim','external','active',0,'8000','', '8000',?,NULL,?,NULL,20)",
          (ms("2027-02-01T00:00:00Z"), ms("2026-11-15T00:00:00Z")))
for now in ("2026-12-01T00:00:00Z", "2027-01-31T23:59:00Z", "2027-02-01T00:00:00Z"):
    r = q(now, now)
    r2 = q(now, now, "status='active'")
    print(now, "술어만:", [(x[0], x[3]) for x in r], "| + status=active:", [(x[0], x[3]) for x in r2])
print("ADR 14.1 필터(rec_to IS NULL + status=active, 유효축 없음):",
      c.execute("SELECT id,value FROM node WHERE expired_at IS NULL AND status='active'").fetchall())
print("-> 같은 applied_seq에서 시계만 지나도 결과가 바뀐다(ETag <epoch>-<applied_seq> 동일)")

print("\n=== B. 민감도 상향: v1 internal -> v2 private, as_of_observed와 history")
c.execute("INSERT INTO node VALUES(3,'f-note',1,'Note','first_party','active',1,'비공개로 바꿀 노트 본문','', NULL,NULL,NULL,?,?,30)",
          (ms("2026-10-01T00:00:00Z"), ms("2026-10-20T00:00:00Z")))
c.execute("INSERT INTO node VALUES(4,'f-note',2,'Note','first_party','active',2,'비공개로 바꿀 노트 본문','', NULL,NULL,NULL,?,NULL,31)",
          (ms("2026-10-20T00:00:00Z"),))
now = "2026-10-31T00:00:00Z"
past = "2026-10-10T00:00:00Z"
print("현재, sensitivity<=1:", q(now, now, "id='f-note' AND sensitivity<=1"))
print("as_of_observed=과거, sensitivity<=1:", q(now, past, "id='f-note' AND sensitivity<=1"))
print("history(버전 행 전체, sensitivity<=1):", c.execute("SELECT id,version,sensitivity FROM node WHERE id='f-note' AND sensitivity<=1").fetchall())

print("\n=== C. 변경 피드: 상향 이벤트는 sensitivity=2라 건너뛴다")
c.executescript("CREATE TABLE change(seq INTEGER PRIMARY KEY, kind TEXT, id TEXT, version INT, sensitivity INT NOT NULL);")
c.execute("INSERT INTO change VALUES(30,'record.put','f-note',1,1)")
c.execute("INSERT INTO change VALUES(31,'record.put','f-note',2,2)")
print("소비자 피드:", c.execute("SELECT seq,kind,id,version FROM change WHERE sensitivity<=1 ORDER BY seq").fetchall(), "<- v2가 없어 소비자는 v1 사본을 계속 가진다")

print("\n=== D. 단건 ETag: 노드 seq 고정, 새 주장은 응답을 바꾼다")
c.executescript("""
CREATE TABLE n2(id TEXT, seq INT, status TEXT);
CREATE TABLE c2(id TEXT, subject TEXT, seq INT, kind TEXT);
INSERT INTO n2 VALUES('e:feature/x', 100, 'active');
""")
etag = lambda: f'"1-{c.execute("SELECT seq FROM n2 WHERE id=?", ("e:feature/x",)).fetchone()[0]}"'
body = lambda: c.execute("SELECT count(*) FROM c2 WHERE subject='e:feature/x'").fetchone()[0]
e1, b1 = etag(), body()
c.execute("INSERT INTO c2 VALUES('c-1','e:feature/x',101,'state')")
print("ETag", e1, "->", etag(), "| claims", b1, "->", body())

print("\n=== E. 키셋: sort=label, 페이지 사이에 라벨 변경(새 버전 행)")
c.executescript("""
CREATE TABLE t(id TEXT, label TEXT, expired INT);
""")
for i, l in enumerate("abcdefghij"):
    c.execute("INSERT INTO t VALUES(?,?,NULL)", (f"e:x/{i}", l))
def page(after, n=5):
    return c.execute("SELECT id,label FROM t WHERE expired IS NULL AND (label,id)>(?,?) ORDER BY label,id LIMIT ?", (*after, n)).fetchall()
p1 = page(("", ""))
print("p1", [x[1] for x in p1])
# e:x/1(b)가 라벨을 z로 바꾼다(이미 본 행이 뒤로), e:x/8(i)이 라벨을 a0으로 바꾼다(안 본 행이 앞으로)
c.execute("UPDATE t SET expired=1 WHERE id='e:x/1'"); c.execute("INSERT INTO t VALUES('e:x/1','z',NULL)")
c.execute("UPDATE t SET expired=1 WHERE id='e:x/8'"); c.execute("INSERT INTO t VALUES('e:x/8','a0',NULL)")
p2 = page(p1[-1])
seen = [x[0] for x in p1 + p2]
allc = [r[0] for r in c.execute("SELECT id FROM t WHERE expired IS NULL")]
print("p2", [x[1] for x in p2])
print("중복:", sorted({i for i in seen if seen.count(i) > 1}), "누락:", sorted(set(allc) - set(seen)))
