"""성능(기본 제외, -m perf): 10만 단위에서 as-of 검색과 희귀 타입 필터 검색 p95 200 ms 이하."""
import random
import time

import pytest

from kb.core.text import index_tokens
from kb.project import create_gold
from kb.read import ReadCtx
from kb.read import search as S

pytestmark = pytest.mark.perf
N = 100_000
T0 = 1_800_000_000_000
_r = random.Random(3)
VOCAB = ["".join(chr(0xAC00 + _r.randrange(2000)) for _ in range(3)) for _ in range(300)] + [f"term{i}" for i in range(200)]


def _build(kb_home):
    g = create_gold(kb_home / "scratch" / "sperf.db")
    rnd = random.Random(11)
    weights = [1 / (i + 1) for i in range(len(VOCAB))]   # 지프 분포: 흔한 단어는 수만 건에 걸린다
    g.execute("BEGIN")
    nodes, heads, units, spans, fts = [], [], [], [], []
    for i in range(N):
        nid = f"e:tool:n{i:06d}"
        typ = "Technique" if i % 1000 == 0 else "Tool"      # 0.1%
        label = " ".join(rnd.choices(VOCAB, weights, k=4)) + f" 고유{i}"
        nodes.append((i + 1, nid, 1, typ, "external", "active", "active", 0, "permanent", label, T0 + i, i + 1))
        heads.append((nid, "node", 1, 0))
        units.append((i + 1, f"{i:064x}", "label"))
        closed = (T0 + i + N // 2) if i % 10 == 0 else None   # 10%는 나중에 닫힌 판
        spans.append((i + 1, i + 1, nid, "node", None, None, typ, "external", "active", "active", None, 0, None, None, None, None,
                      None, None, T0 + i, closed))
        fts.append((i + 1, " ".join(index_tokens(label))))
    g.executemany("INSERT INTO node(vid,id,version,type,origin,status,eff_status,sensitivity,retention,label,recorded_at,seq) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", nodes)
    g.executemany("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,?,?,?)", heads)
    g.executemany("INSERT INTO unit(rid,sha,kind) VALUES(?,?,?)", units)
    g.executemany("INSERT INTO span(sid,unit_rid,ref_id,ref_kind,subject,claim_kind,type,origin,status,eff_status,verification,"
                  "sensitivity,start_cp,end_cp,snapshot_id,source_id,valid_from,valid_to,rec_from,rec_to) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", spans)
    g.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", fts)
    g.execute("UPDATE meta SET v=? WHERE k='applied_seq'", (str(N),))
    g.execute("COMMIT")
    g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return g


def _p95(f, qs):
    ts = []
    for q in qs:
        t = time.perf_counter()
        f(q)
        ts.append((time.perf_counter() - t) * 1e3)
    ts.sort()
    return ts[int(len(ts) * 0.95)]


def test_p95_asof_and_rare_type(kb_home):
    g = _build(kb_home)
    path = kb_home / "scratch" / "sperf.db"
    rnd = random.Random(5)
    qs = [" ".join(rnd.choices(VOCAB[:60], k=2)) for _ in range(40)] + [VOCAB[0], VOCAB[1], VOCAB[2]]
    asof = ReadCtx.build(db_path=path, as_of_observed=T0 + N // 4)
    rare = ReadCtx.build(db_path=path, types="Technique")
    default = ReadCtx.build(db_path=path)
    r_as = _p95(lambda q: S.search(q, asof, limit=50), qs)
    r_rare = _p95(lambda q: S.search(q, rare, limit=50), qs)
    r_def = _p95(lambda q: S.search(q, default, limit=50), qs)
    print(f"p95 ms as-of={r_as:.1f} rare-type={r_rare:.1f} default={r_def:.1f}")
    # 정확성: 희귀 타입 필터의 total은 정답(안쪽 LIMIT 없는 개수)과 같다
    res = S.search("term1", rare, limit=50)
    truth = g.execute("SELECT COUNT(DISTINCT s.ref_id) FROM span s WHERE s.type='Technique' AND s.rec_to IS NULL "
                      "AND s.unit_rid IN (SELECT rowid FROM fts WHERE fts MATCH '\"term1\"')").fetchone()[0]
    assert res["page"]["total"] == truth
    assert r_as <= 200 and r_rare <= 200 and r_def <= 200
    g.close()
