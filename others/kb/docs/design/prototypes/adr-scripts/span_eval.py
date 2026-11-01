"""문서 전문 as-of: 고유 문단 FTS + 문단 존속 구간(span) 조인 측정.
문서가 바뀌면 사라진 문단의 span만 닫고 새 문단의 span만 연다. 색인은 고유 문단 수에 비례한다."""
import json, random, re, sqlite3, sys, time, unicodedata, os

base, dbp, target = sys.argv[1], sys.argv[2], int(sys.argv[3])
docs = json.load(open(f"{base}/docs.json"))
qs = json.load(open(f"{base}/queries.json"))
HANGUL = "가-힣"
RUN = re.compile(rf"[{HANGUL}]+|[a-z0-9]+")


def toks(t):
    out = []
    for m in RUN.finditer(unicodedata.normalize("NFC", t).lower()):
        w = m.group()
        if re.match(rf"[{HANGUL}]", w):
            if len(w) == 1:
                out.append(w)
            else:
                out.extend(w[i : i + 2] for i in range(len(w) - 1))
                if len(w) <= 3:
                    out.append(w[0])
        else:
            out.append(w)
    return out


if os.path.exists(dbp):
    os.remove(dbp)
c = sqlite3.connect(dbp, isolation_level=None)
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA synchronous=OFF")
c.executescript(
    """
CREATE TABLE para(rid INTEGER PRIMARY KEY, sha TEXT UNIQUE);
CREATE TABLE span(sid INTEGER PRIMARY KEY, para INT NOT NULL, doc INT NOT NULL, rec_from INT NOT NULL, rec_to INT, life INT NOT NULL, sens INT NOT NULL);
CREATE INDEX span_para ON span(para, rec_from);
CREATE INDEX span_doc_open ON span(doc) WHERE rec_to IS NULL;
CREATE VIRTUAL TABLE f USING fts5(tok, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 0");
"""
)
rnd = random.Random(42)
base_par = []
for d in docs:
    t = d["text"]
    for i in range(0, len(t), 450):
        p = t[i : i + 450]
        if len(p) > 40:
            base_par.append(p)
T0 = 1_000_000
weeks = 52
t0 = time.perf_counter()
nd = max(1, target // (30 * 2))
rid = 0
sid = 0
c.execute("BEGIN")
cur = {}
batch_p, batch_f, batch_s = [], [], []


def newpara(week, doc):
    global rid
    rid += 1
    txt = rnd.choice(base_par)
    batch_f.append((rid, " ".join(toks(txt))))
    return rid


for doc in range(nd):
    ps = []
    for j in range(30):
        r = newpara(0, doc)
        sid += 1
        batch_s.append((sid, r, doc, T0, None, 0, 1))
        ps.append(sid)
    cur[doc] = ps
closed = []
for w in range(1, weeks + 1):
    at = T0 + w * 604800
    for doc in range(nd):
        if rnd.random() < 0.5:  # 문서 절반이 그 주에 바뀐다
            for k in range(30):
                if rnd.random() < 0.06:
                    closed.append((at, cur[doc][k]))
                    r = newpara(w, doc)
                    sid += 1
                    batch_s.append((sid, r, doc, at, None, 0, 1))
                    cur[doc][k] = sid
c.executemany("INSERT INTO span VALUES(?,?,?,?,?,?,?)", batch_s)
c.executemany("UPDATE span SET rec_to=? WHERE sid=?", closed)
c.executemany("INSERT INTO f(rowid,tok) VALUES(?,?)", batch_f)
c.execute("COMMIT")
c.execute("INSERT INTO f(f) VALUES('optimize')")
c.execute("ANALYZE")
c.close()
build = time.perf_counter() - t0
c = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True, isolation_level=None)
n_span = c.execute("select count(*) from span").fetchone()[0]
n_open = c.execute("select count(*) from span where rec_to is null").fetchone()[0]


def expr(q):
    t = list(dict.fromkeys(toks(q)))[:16]
    return " OR ".join('"' + x + '"' for x in t)


CUR = """SELECT s.doc, s.para FROM (SELECT rowid r, bm25(f) b FROM f WHERE f MATCH ? ORDER BY b LIMIT 400) x
 JOIN span s ON s.para=x.r WHERE s.rec_to IS NULL AND s.life=0 AND s.sens<=1 ORDER BY x.b LIMIT 30"""
ASOF = """SELECT s.doc, s.para FROM (SELECT rowid r, bm25(f) b FROM f WHERE f MATCH ? ORDER BY b LIMIT 2000) x
 JOIN span s ON s.para=x.r WHERE s.rec_from<=? AND (s.rec_to IS NULL OR s.rec_to>?) AND s.sens<=1 ORDER BY x.b LIMIT 30"""
res = {}
for name, sql, args in (("current", CUR, lambda: ()), ("asof_mid", ASOF, lambda: (T0 + 26 * 604800, T0 + 26 * 604800)), ("asof_old", ASOF, lambda: (T0 + 604800, T0 + 604800))):
    lat = []
    got = []
    for round_ in range(2):
        lat = []
        for q in qs[:300]:
            e = expr(q["q"])
            if not e:
                continue
            t = time.perf_counter()
            r = c.execute(sql, (e, *args())).fetchall()
            lat.append((time.perf_counter() - t) * 1e3)
            got.append(len(r))
    lat.sort()
    res[name] = {"p50": round(lat[len(lat) // 2], 2), "p95": round(lat[int(len(lat) * 0.95)], 2), "avg_hits": round(sum(got) / len(got), 1)}
print(json.dumps({"docs": nd, "paragraphs": rid, "spans": n_span, "open": n_open, "db_MB": round(os.path.getsize(dbp) / 1e6, 1), "build_s": round(build, 1), **res}, ensure_ascii=False))
