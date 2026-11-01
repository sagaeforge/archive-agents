"""ADR 7.2 span/fts와 계약 4.8, 4.9를 합성 데이터로 잰다. 값은 합성이고 지식 데이터가 아니다.
규모: 단위 N(기본 30만). ADR 추정 주장 10만~30만 + 문단 5만~15만 범위 안.
토큰은 Zipf 분포 합성 bigram이다. 실제 한국어 분포와 다를 수 있어 지연 값은 경향으로만 쓴다."""
import json, os, random, sqlite3, sys, time

dbp, N = sys.argv[1], int(sys.argv[2])
if os.path.exists(dbp):
    os.remove(dbp)
for s in ("-wal", "-shm"):
    if os.path.exists(dbp + s):
        os.remove(dbp + s)
c = sqlite3.connect(dbp, isolation_level=None)
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA synchronous=OFF")
c.executescript("""
CREATE TABLE node(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL, type TEXT NOT NULL,
  origin TEXT NOT NULL, status TEXT NOT NULL, liveness TEXT, verification TEXT, sensitivity INT NOT NULL,
  domain TEXT, label TEXT NOT NULL, props TEXT, recorded_at INT NOT NULL, expired_at INT, seq INT NOT NULL, UNIQUE(id, version));
CREATE TABLE evidence(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, snapshot_id TEXT NOT NULL);
CREATE TABLE unit(rid INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
CREATE TABLE span(sid INTEGER PRIMARY KEY, unit_rid INT NOT NULL, ref_id TEXT NOT NULL, ref_kind TEXT NOT NULL,
  type TEXT NOT NULL, origin TEXT NOT NULL, domain TEXT, status TEXT NOT NULL, eff_status TEXT NOT NULL,
  verification TEXT, sensitivity INT NOT NULL, rec_from INT NOT NULL, rec_to INT);
CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 0");
""")
rnd = random.Random(11)
V = 4000
vocab = [f"t{i:04d}" for i in range(V)]
weights = [1 / (i + 1) ** 0.9 for i in range(V)]
cum = []
acc = 0
for w in weights:
    acc += w
    cum.append(acc)

t0 = time.time()
# 스냅샷 5만, 소스 300
SN = 50000
SRC = 300
nodes = []
for i in range(SN):
    nodes.append((None, f"n-{i:016x}", 1, "Snapshot", "external", "active", None, None, 0, "G", f"snap{i}", json.dumps({"source": f"src:s{i % SRC}"}), 1000 + i, None, i))
c.execute("BEGIN")
c.executemany("INSERT INTO node VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", nodes)
batch_u, batch_s, batch_f, batch_n, batch_e = [], [], [], [], []
TYPES = [("Claim", 0.66), ("Snapshot", 0.33), ("Note", 0.004), ("Decision", 0.001), ("Feature", 0.005)]
cumt = []
a = 0
for t, p in TYPES:
    a += p
    cumt.append((a, t))
import bisect
keys = [x[0] for x in cumt]
toks = rnd.choices(vocab, cum_weights=cum, k=N * 24)
for i in range(N):
    rid = i + 1
    t = cumt[bisect.bisect_left(keys, rnd.random() * a)][1]
    origin = "first_party" if t in ("Note", "Decision") else "external"
    status = rnd.choices(["active", "superseded", "dead"], [0.9, 0.08, 0.02])[0]
    ver = "quote_found" if rnd.random() < 0.8 else "needs_review" if t == "Claim" else "parser_derived"
    batch_u.append((rid, f"sha{rid}", "claim" if t == "Claim" else "passage"))
    ref = f"c-{rid:012d}"
    batch_s.append((rid, rid, ref, "claim", t, origin, rnd.choice("ABCDEFG"), status, status, ver, rnd.choice([0, 0, 0, 1, 2]) if origin == "first_party" else 0, 1000 + rid, None))
    batch_f.append((rid, " ".join(toks[i * 24 : i * 24 + 24])))
    if t == "Claim":
        batch_n.append((None, ref, 1, "Claim", "external", status, None, ver, 0, "G", ref, "{}", 1000 + rid, None, rid))
        batch_e.append((f"ev{rid}", ref, f"n-{rnd.randrange(SN):016x}"))
    if len(batch_u) >= 20000:
        c.executemany("INSERT INTO unit VALUES(?,?,?)", batch_u)
        c.executemany("INSERT INTO span VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_s)
        c.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", batch_f)
        c.executemany("INSERT INTO node VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_n)
        c.executemany("INSERT INTO evidence VALUES(?,?,?)", batch_e)
        batch_u, batch_s, batch_f, batch_n, batch_e = [], [], [], [], []
c.executemany("INSERT INTO unit VALUES(?,?,?)", batch_u)
c.executemany("INSERT INTO span VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_s)
c.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", batch_f)
c.executemany("INSERT INTO node VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_n)
c.executemany("INSERT INTO evidence VALUES(?,?,?)", batch_e)
c.execute("COMMIT")
c.execute("INSERT INTO fts(fts) VALUES('optimize')")
c.executescript("""
CREATE INDEX span_para ON span(unit_rid, rec_from);
CREATE INDEX span_open ON span(type, origin, status) WHERE rec_to IS NULL;
CREATE INDEX node_cur ON node(type, status) WHERE expired_at IS NULL;
CREATE INDEX node_id ON node(id) WHERE expired_at IS NULL;
CREATE INDEX ev_claim ON evidence(claim_id);
ANALYZE;
""")
print(json.dumps({"build_s": round(time.time() - t0, 1), "units": N, "db_MB": round(os.path.getsize(dbp) / 1e6, 1)}))
c.close()
c = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True, isolation_level=None)

VIS = "s.rec_to IS NULL AND s.eff_status='active' AND s.verification IN ('quote_found','parser_derived','first_party') AND s.sensitivity<=1"
TOPN = f"""SELECT s.ref_id FROM (SELECT rowid r, bm25(fts) b FROM fts WHERE fts MATCH ? ORDER BY b LIMIT 400) x
 JOIN span s ON s.unit_rid=x.r WHERE {VIS} AND s.type=? ORDER BY x.b LIMIT 50"""
TOTAL = f"""SELECT count(*) FROM fts JOIN span s ON s.unit_rid=fts.rowid WHERE fts MATCH ? AND {VIS} AND s.type=?"""
FACET = f"""SELECT count(*), s.type, s.origin, s.status, s.domain FROM fts JOIN span s ON s.unit_rid=fts.rowid WHERE fts MATCH ? AND {VIS} GROUP BY 2,3,4,5"""


def q2(i, j):
    return f'"{vocab[i]}" OR "{vocab[j]}"'


def lat(fn, n):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1e3)
    out.sort()
    return {"p50": round(out[len(out) // 2], 1), "p95": round(out[max(0, int(len(out) * 0.95) - 1)], 1), "max": round(out[-1], 1)}


print("\n[A] 상위 400 뒤 필터 대 실제 개수, 단일 토큰")
for tok_idx in (0, 5, 30, 200, 1500):
    q = f'"{vocab[tok_idx]}"'
    mt = c.execute("SELECT count(*) FROM fts WHERE fts MATCH ?", (q,)).fetchone()[0]
    for ty in ("Note", "Decision", "Feature"):
        top = len(c.execute(TOPN, (q, ty)).fetchall())
        tot = c.execute(TOTAL, (q, ty)).fetchone()[0]
        print(f"  토큰#{tok_idx} 일치 {mt:>7} types={ty:<9} 상위N경로 {top:>3}건 / 실제 {tot:>5}건")

print("\n[B] 검색 지연. q = 두 토큰 OR(AND 뒤 OR 경로), 질의 40개")
pairs = [(rnd.randrange(0, 60), rnd.randrange(0, 400)) for _ in range(40)]
it = iter(range(10 ** 9))
print("  상위 400 + 필터:", lat(lambda: c.execute(TOPN, (q2(*pairs[next(it) % 40]), "Claim")).fetchall(), 40))
it = iter(range(10 ** 9))
print("  정확 total(필터 적용 전체 개수):", lat(lambda: c.execute(TOTAL, (q2(*pairs[next(it) % 40]), "Claim")).fetchone(), 40))
it = iter(range(10 ** 9))
print("  /v1/facets?q= 정확 패싯(4축 묶음, source 제외):", lat(lambda: c.execute(FACET, (q2(*pairs[next(it) % 40]),)).fetchall(), 40))

print("\n[C] q 없는 /v1/facets. 현재 필터 적용, 주장 기준")
F = {
    "type": "SELECT type,count(*) FROM node WHERE expired_at IS NULL AND status='active' AND sensitivity<=1 GROUP BY 1",
    "origin": "SELECT origin,count(*) FROM node WHERE expired_at IS NULL AND status='active' AND sensitivity<=1 GROUP BY 1",
    "domain": "SELECT domain,count(*) FROM node WHERE expired_at IS NULL AND status='active' AND sensitivity<=1 GROUP BY 1",
    "status": "SELECT status,count(*) FROM node WHERE expired_at IS NULL AND sensitivity<=1 GROUP BY 1",
    "source": """SELECT json_extract(n.props,'$.source') s, count(*) FROM node c JOIN evidence e ON e.claim_id=c.id
                 JOIN node n ON n.id=e.snapshot_id AND n.expired_at IS NULL
                 WHERE c.type='Claim' AND c.expired_at IS NULL AND c.status='active' AND c.sensitivity<=1 GROUP BY 1""",
}
tot = 0
for k, sql in F.items():
    r = lat(lambda: c.execute(sql).fetchall(), 7)
    print(f"  {k}: {r}")
    tot += r["p50"]
print("  5축 합(p50):", round(tot, 1), "ms")
print(c.execute("EXPLAIN QUERY PLAN " + F["source"]).fetchall())

print("\n[D] 대안: 전체 일치에 필터를 건 뒤 bm25 순위 상위 50")
FULL = f"""SELECT s.ref_id FROM fts JOIN span s ON s.unit_rid=fts.rowid WHERE fts MATCH ? AND {VIS} AND s.type=? ORDER BY bm25(fts) LIMIT 50"""
for ty in ("Claim","Note"):
    it = iter(range(10 ** 9))
    print(f"  types={ty}:", lat(lambda: c.execute(FULL, (q2(*pairs[next(it) % 40]), ty)).fetchall(), 40))
    print("   토큰#0:", len(c.execute(FULL, (f'"{vocab[0]}"', ty)).fetchall()), "건 반환")
c.close()
c = sqlite3.connect(dbp, isolation_level=None)
c.executescript("""
ALTER TABLE span ADD COLUMN source_id TEXT;
""")
c.execute("BEGIN")
c.execute("""UPDATE span SET source_id=(SELECT json_extract(n.props,'$.source') FROM evidence e JOIN node n ON n.id=e.snapshot_id AND n.expired_at IS NULL WHERE e.claim_id=span.ref_id LIMIT 1)""")
c.execute("COMMIT")
c.execute("CREATE INDEX span_src ON span(source_id) WHERE rec_to IS NULL")
c.execute("ANALYZE")
c.close()
c = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True, isolation_level=None)
print("[E] 대안: span.source_id 비정규화 후 source 패싯:", lat(lambda: c.execute(f"SELECT s.source_id,count(*) FROM span s WHERE {VIS} GROUP BY 1").fetchall(), 7))

c.close()
c = sqlite3.connect(dbp, isolation_level=None)
c.execute("CREATE INDEX span_cov ON span(source_id, eff_status, verification, sensitivity) WHERE rec_to IS NULL")
c.execute("ANALYZE")
c.close()
c = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True, isolation_level=None)
print("[F] 대안: 커버링 부분 색인 뒤 source 패싯:", lat(lambda: c.execute(f"SELECT s.source_id,count(*) FROM span s WHERE {VIS} GROUP BY 1").fetchall(), 7))
print(c.execute(f"EXPLAIN QUERY PLAN SELECT s.source_id,count(*) FROM span s WHERE {VIS} GROUP BY 1").fetchall())
