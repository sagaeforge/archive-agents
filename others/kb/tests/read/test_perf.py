"""성능(기본 제외, -m perf): 1만 노드·5만 엣지에서 상세·이웃 p95 200 ms 이하, 개요 2초 이하."""
import random
import time

import pytest

from kb import read
from kb.project import create_gold

pytestmark = pytest.mark.perf
N, M = 10_000, 50_000


def _build(kb_home):
    g = create_gold(kb_home / "scratch" / "perf.db")
    rnd = random.Random(7)
    t = 1_800_000_000_000
    g.execute("BEGIN")
    nodes, heads, doms, claims, cl = [], [], [], [], []
    for i in range(N):
        nid = f"e:tool:n{i:05d}"
        nodes.append((i + 1, nid, 1, "Tool", "external", "active", "active", 0, "permanent", f"도구 {i}", t + i, i + 1))
        heads.append((nid, "node", 1, 0))
        doms.append(("G", nid))
        cid = f"c-{i:06d}"
        vid = N + i + 1
        nodes.append((vid, cid, 1, "Claim", "external", "active", "active", 0, "permanent", f"도구 {i}는 기능이 있다", t + i, N + i + 1))
        heads.append((cid, "node", 1, 0))
        cl.append((vid, nid, f"도구 {i}는 기능이 있다"))
    g.executemany("INSERT INTO node(vid,id,version,type,origin,status,eff_status,sensitivity,retention,label,recorded_at,seq) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", nodes)
    g.executemany("INSERT INTO claim(vid,subject,statement,kind,stance,method) VALUES(?,?,?, 'state','stated','llm')", cl)
    g.executemany("INSERT INTO node_domain(domain,node_id) VALUES(?,?)", doms)
    edges = []
    for k in range(M):
        a = 0 if k < 500 else rnd.randrange(N)  # 허브 하나
        b = rnd.randrange(N)
        eid = f"r-{k:06d}"
        edges.append((k + 1, eid, 1, f"e:tool:n{a:05d}", "USES", f"e:tool:n{b:05d}", "active", 0, t, k + 1))
        heads.append((eid, "edge", 1, 0))
    g.executemany("INSERT INTO edge(vid,id,version,src,rtype,dst,status,sensitivity,recorded_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?)", edges)
    g.executemany("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,?,?,?)", heads)
    g.execute("UPDATE meta SET v=? WHERE k='applied_seq'", (str(N * 2),))
    g.execute("COMMIT")
    g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return g


def _p95(f, n=100):
    ts = []
    for i in range(n):
        t0 = time.perf_counter()
        f(i)
        ts.append(time.perf_counter() - t0)
    ts.sort()
    return ts[int(n * 0.95) - 1]


def test_perf(kb_home):
    g = _build(kb_home)
    try:
        ctx = read.ReadCtx.build(db_path=kb_home / "scratch" / "perf.db")
        rnd = random.Random(3)
        pick = lambda i: f"e:tool:n{(0 if i % 10 == 0 else rnd.randrange(N)):05d}"  # 10%는 허브
        detail = _p95(lambda i: read.read(ctx, read.get_node, pick(i)))
        neigh = _p95(lambda i: read.read(ctx, read.neighbors, pick(i)))
        t0 = time.perf_counter()
        env = read.read(ctx, read.overview, limit=10_000, edge_limit=50_000)
        ov = time.perf_counter() - t0
        print(f"detail p95={detail * 1000:.1f}ms neighbors p95={neigh * 1000:.1f}ms overview={ov:.2f}s truncated={env['page']['truncated']}")
        assert env["data"]["meta"]["node_total"] == N
        assert detail <= 0.2, detail
        assert neigh <= 0.2, neigh
        assert ov <= 2.0, ov
    finally:
        g.close()
