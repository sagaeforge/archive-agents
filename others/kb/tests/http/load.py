"""HTTP 읽기 API 부하 시험(WP-10). 합성 데이터와 쓰기 동시 실행으로 Unix 소켓 경유 지연을 잰다.

  ops/bin/dev python tests/http/load.py --nodes 400000 --edges 1500000 --units 150000 \
      --overview-nodes 50000 --overview-edges 200000 --cold 20 --json

- 데이터는 전부 합성이고 시험 폴더(디스크)의 임시 gold에만 있다. 지식 데이터로 저장하지 않는다.
- 서버는 `kb serve --http --unix`를 자식 프로세스로 띄우고 http.client로 소켓에 붙는다.
- 쓰기 동시 실행: 별도 스레드가 같은 gold에 20 ms 간격으로 작은 트랜잭션을 쓴다(applied_seq가 계속 오른다).
- --cold N: 서버를 내린 상태에서 소켓을 쥔 활성화기(systemd Accept=no 소켓 유닛 흉내)가 첫 연결에 서버를 띄운다.
  기동 시간을 포함한 첫 요청을 N회 재서 cold_* 값을 낸다. 페이지 캐시는 데워진 상태다(재부팅 직후 값은 WP-14 입회 시험).
- 수치는 ms. p95는 상위 5% 경계, p100은 최댓값이다.
"""
from __future__ import annotations

import argparse
import http.client
import json
import math
import os
import random
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

T0 = 1_800_000_000_000
DOMAINS = "ABCDEFG"
OV_TYPES = ["Tool", "Feature", "Product", "Concept", "Technique"]
SOURCES = [f"src:s{i}" for i in range(8)]
_r = random.Random(3)
VOCAB = ["".join(chr(0xAC00 + _r.randrange(2000)) for _ in range(3)) for _ in range(300)] + [f"term{i}" for i in range(200)]


# ------------------------------------------------------------------ 합성 데이터

def build_gold(path: Path, nodes: int, edges: int, units: int, ov_nodes: int, ov_edges: int, seed: int = 11) -> dict:
    from kb.core.text import index_tokens
    from kb.project import create_gold
    rnd = random.Random(seed)
    g = create_gold(path)
    n_ov = int(ov_nodes * 1.1)                      # 개요 한도보다 10% 많게(잘림 경로를 탄다)
    n_cl = max(0, units - n_ov)                     # 주장 = 단위 - 개체 라벨 단위
    n_rest = max(0, nodes - n_ov - n_cl)
    n_kw, n_vid = n_rest * 6 // 10, n_rest * 4 // 10
    e_ov = int(ov_edges * 1.25)
    e_cl = min(n_cl, max(0, edges - e_ov))
    e_rest = max(0, edges - e_ov - e_cl)
    weights = [1 / (i + 1) for i in range(len(VOCAB))]
    g.execute("BEGIN")
    seq = 0
    vid = 0
    ids_ov, ids_cl, ids_kw, ids_vid = [], [], [], []

    def flush(rows_n, rows_h, rows_dom=None, rows_cl=None, rows_u=None, rows_s=None, rows_f=None, rows_c=None):
        g.executemany("INSERT INTO node(vid,id,version,type,origin,status,eff_status,verification,sensitivity,retention,label,"
                      "recorded_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows_n)
        g.executemany("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,?,?,?)", rows_h)
        if rows_dom:
            g.executemany("INSERT INTO node_domain(domain,node_id) VALUES(?,?)", rows_dom)
        if rows_cl:
            g.executemany("INSERT INTO claim(vid,subject,predicate,statement,kind,stance,method) VALUES(?,?,?,?, 'state','stated','llm')", rows_cl)
        if rows_u:
            g.executemany("INSERT INTO unit(rid,sha,kind) VALUES(?,?,?)", rows_u)
        if rows_s:
            g.executemany("INSERT INTO span(sid,unit_rid,ref_id,ref_kind,subject,claim_kind,type,origin,status,eff_status,verification,"
                          "sensitivity,start_cp,end_cp,snapshot_id,source_id,valid_from,valid_to,rec_from,rec_to) "
                          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows_s)
        if rows_f:
            g.executemany("INSERT INTO fts(rowid,tok) VALUES(?,?)", rows_f)
        if rows_c:
            g.executemany("INSERT INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,0,?,?,?,1,'external',?,0)", rows_c)

    unit = 0
    # 개요 대상 개체
    batch = ([], [], [], None, [], [], [], [])
    for i in range(n_ov):
        vid += 1
        seq += 1
        typ = OV_TYPES[i % len(OV_TYPES)]
        nid = f"e:{typ.lower()}:n{i:06d}"
        ids_ov.append(nid)
        label = " ".join(rnd.choices(VOCAB, weights, k=3)) + f" 개체{i}"
        unit += 1
        batch[0].append((vid, nid, 1, typ, "external", "active", "active", None, 0, "permanent", label, T0 + i, seq))
        batch[1].append((nid, "node", 1, 0))
        batch[2].append((DOMAINS[i % 7], nid))
        batch[4].append((unit, f"{unit:064x}", "label"))
        batch[5].append((unit, unit, nid, "node", None, None, typ, "external", "active", "active", None, 0, None, None, None,
                         SOURCES[i % 8], None, None, T0 + i, None))
        batch[6].append((unit, " ".join(index_tokens(label))))
        batch[7].append((seq, T0 + i, "entity.put", nid, typ))
        if len(batch[0]) >= 20000:
            flush(batch[0], batch[1], batch[2], None, batch[4], batch[5], batch[6], batch[7])
            batch = ([], [], [], None, [], [], [], [])
    flush(batch[0], batch[1], batch[2], None, batch[4], batch[5], batch[6], batch[7])
    # 주장
    batch = ([], [], [], [], [], [], [], [])
    for i in range(n_cl):
        vid += 1
        seq += 1
        unit += 1
        cid = f"c-{i:07d}"
        ids_cl.append(cid)
        subj = ids_ov[rnd.randrange(n_ov)]
        stmt = " ".join(rnd.choices(VOCAB, weights, k=6)) + f" 주장{i}"
        batch[0].append((vid, cid, 1, "Claim", "external", "active", "active", "quote_found", 0, "permanent", stmt, T0 + i, seq))
        batch[1].append((cid, "node", 1, 0))
        batch[3].append((vid, subj, "supports", stmt))
        batch[4].append((unit, f"{unit:064x}", "statement"))
        batch[5].append((unit, unit, cid, "node", subj, "state", "Claim", "external", "active", "active", "quote_found", 0, None, None,
                         None, SOURCES[i % 8], None, None, T0 + i, None))
        batch[6].append((unit, " ".join(index_tokens(stmt))))
        batch[7].append((seq, T0 + n_ov + i, "claim.assert", cid, "Claim"))
        if len(batch[0]) >= 20000:
            flush(batch[0], batch[1], None, batch[3], batch[4], batch[5], batch[6], batch[7])
            batch = ([], [], [], [], [], [], [], [])
    flush(batch[0], batch[1], None, batch[3], batch[4], batch[5], batch[6], batch[7])
    # 나머지 세계 노드
    for kind, count, typ, bucket in (("keyword", n_kw, "Keyword", ids_kw), ("video", n_vid, "Video", ids_vid)):
        rows_n, rows_h, rows_d = [], [], []
        for i in range(count):
            vid += 1
            seq += 1
            nid = f"e:{kind}:{kind[0]}{i:07d}"
            bucket.append(nid)
            rows_n.append((vid, nid, 1, typ, "external", "active", "active", None, 0, "permanent", f"{kind} {i}", T0 + i, seq))
            rows_h.append((nid, "node", 1, 0))
            rows_d.append((DOMAINS[i % 7], nid))
            if len(rows_n) >= 40000:
                flush(rows_n, rows_h, rows_d)
                rows_n, rows_h, rows_d = [], [], []
        flush(rows_n, rows_h, rows_d)
    # 엣지: 개요 노드 사이(허브 하나), 주장 ABOUT, 나머지는 키워드·영상 사이
    eid = 0
    ecount = 0

    def edge_batch(n, pick_src, pick_dst, rtype):
        nonlocal eid, seq, ecount
        rows_e, rows_h, rows_c = [], [], []
        for k in range(n):
            eid += 1
            seq += 1
            e = f"r-{eid:08d}"
            rows_e.append((eid, e, 1, pick_src(k), rtype(k), pick_dst(k), "active", 0, T0 + k, seq))
            rows_h.append((e, "edge", 1, 0))
            rows_c.append((seq, T0 + k, "edge.put", e, None))
            if len(rows_e) >= 50000:
                g.executemany("INSERT INTO edge(vid,id,version,src,rtype,dst,status,sensitivity,recorded_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?)", rows_e)
                g.executemany("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,?,?,?)", rows_h)
                g.executemany("INSERT INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,0,?,?,?,1,'external',?,0)", rows_c)
                rows_e, rows_h, rows_c = [], [], []
        g.executemany("INSERT INTO edge(vid,id,version,src,rtype,dst,status,sensitivity,recorded_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?)", rows_e)
        g.executemany("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,?,?,?)", rows_h)
        g.executemany("INSERT INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,0,?,?,?,1,'external',?,0)", rows_c)
        ecount += n

    rtypes = ["USES", "PART_OF", "HAS_FEATURE", "DEPENDS_ON", "RUNS_ON"]
    edge_batch(e_ov, lambda k: ids_ov[0] if k < 2000 else ids_ov[rnd.randrange(n_ov)], lambda k: ids_ov[rnd.randrange(n_ov)],
               lambda k: rtypes[k % 5])
    edge_batch(e_cl, lambda k: ids_cl[k], lambda k: ids_ov[rnd.randrange(n_ov)], lambda k: "ABOUT")
    pool = ids_kw + ids_vid
    if pool and e_rest:
        edge_batch(e_rest, lambda k: pool[rnd.randrange(len(pool))], lambda k: pool[rnd.randrange(len(pool))], lambda k: "MENTIONS")
    g.execute("UPDATE meta SET v=? WHERE k='applied_seq'", (str(seq),))
    g.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('build_id',?)", (f"g-{seq:09d}-load",))
    g.execute("COMMIT")
    g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    g.execute("ANALYZE")
    g.close()
    return {"nodes": vid, "edges": ecount, "units": unit, "overview_type_nodes": n_ov, "claims": n_cl, "applied_seq": seq,
            "ids_ov": ids_ov[:5000], "last_vid": vid, "last_eid": eid}


# ------------------------------------------------------------------ 클라이언트와 서버 수명

class UDS(http.client.HTTPConnection):
    def __init__(self, path, timeout=60):
        super().__init__("localhost", timeout=timeout)
        self.uds = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(self.timeout)
        s.connect(self.uds)
        self.sock = s


def get(sock_path, target, timeout=60):
    c = UDS(sock_path, timeout)
    t0 = time.perf_counter()
    try:
        c.request("GET", target)
        r = c.getresponse()
        body = r.read()
        return r.status, (time.perf_counter() - t0) * 1000, body
    finally:
        c.close()


def pct(vals, q):
    s = sorted(vals)
    if not s:
        return None
    if q >= 100:
        return round(s[-1], 2)
    return round(s[max(0, math.ceil(len(s) * q / 100) - 1)], 2)


class Writer(threading.Thread):
    """같은 gold에 작은 쓰기 트랜잭션을 계속 낸다(합성 노드 추가)."""

    def __init__(self, path, vid, eid, seq, interval=0.02):
        super().__init__(daemon=True)
        self.path, self.vid, self.eid, self.seq, self.interval = path, vid, eid, seq, interval
        self.stop_ev, self.lat, self.errors = threading.Event(), [], 0

    def run(self):
        from kb.core.conn import connect_rw
        con = connect_rw(self.path, "NORMAL")
        n = 0
        while not self.stop_ev.is_set():
            t0 = time.perf_counter()
            try:
                con.execute("BEGIN IMMEDIATE")
                self.vid += 1
                self.seq += 1
                nid = f"e:tool:w{n:07d}"
                con.execute("INSERT INTO node(vid,id,version,type,origin,status,eff_status,sensitivity,retention,label,recorded_at,seq) "
                            "VALUES(?,?,1,'Tool','external','active','active',0,'permanent',?,?,?)", (self.vid, nid, f"쓰기 {n}", T0 + n, self.seq))
                con.execute("INSERT INTO head(id,kind,version,sensitivity) VALUES(?,'node',1,0)", (nid,))
                con.execute("INSERT INTO change(seq,sub,at,kind,id,version,origin,type,sensitivity) VALUES(?,0,?,'entity.put',?,1,'external','Tool',0)",
                            (self.seq, T0 + n, nid))
                con.execute("UPDATE meta SET v=? WHERE k='applied_seq'", (str(self.seq),))
                con.execute("COMMIT")
            except sqlite3.Error:
                self.errors += 1
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            self.lat.append((time.perf_counter() - t0) * 1000)
            n += 1
            self.stop_ev.wait(self.interval)
        con.close()


def server_cmd(db, idle=3600):
    return [sys.executable, "-m", "kb", "serve", "--http", "--idle-s", str(idle), "--db", str(db)]


class Server:
    """kb serve를 --unix로 띄운다."""

    def __init__(self, db, sock):
        self.db, self.sock = db, sock
        self.p = subprocess.Popen(server_cmd(db) + ["--unix", str(sock)], stderr=subprocess.DEVNULL)
        end = time.monotonic() + 60
        while not os.path.exists(sock) and time.monotonic() < end:
            time.sleep(0.05)
        get(str(sock), "/v1/meta")

    def close(self):
        self.p.send_signal(signal.SIGTERM)
        try:
            self.p.wait(15)
        except subprocess.TimeoutExpired:
            self.p.kill()


class Activator:
    """소켓을 쥐고 있다가 첫 연결에 서버를 LISTEN_FDS로 띄운다(systemd Accept=no 소켓 유닛 흉내)."""

    def __init__(self, db, sock):
        self.db, self.sock = db, str(sock)
        if os.path.exists(self.sock):
            os.unlink(self.sock)
        self.lsock = socket.socket(socket.AF_UNIX)
        self.lsock.bind(self.sock)
        os.chmod(self.sock, 0o600)
        self.lsock.listen(64)
        self.child, self.stop = None, False
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()

    def _loop(self):
        while not self.stop:
            r, _, _ = select.select([self.lsock], [], [], 0.05)
            if r and (self.child is None or self.child.poll() is not None):
                fd = self.lsock.fileno()
                self.child = subprocess.Popen(
                    ["sh", "-c", 'exec env LISTEN_PID=$$ LISTEN_FDS=1 "$@"', "sh", *server_cmd(self.db)],
                    preexec_fn=lambda: (os.dup2(fd, 3), os.set_inheritable(3, True)), close_fds=False, stderr=subprocess.DEVNULL)
                time.sleep(0.2)

    def down(self):
        c = self.child
        if c is not None and c.poll() is None:
            c.send_signal(signal.SIGTERM)
            try:
                c.wait(15)
            except subprocess.TimeoutExpired:
                c.kill()
                c.wait()

    def close(self):
        self.stop = True
        self.t.join(2)
        self.down()
        self.lsock.close()
        try:
            os.unlink(self.sock)
        except OSError:
            pass


# ------------------------------------------------------------------ 측정

def run(args) -> dict:
    base = Path(args.dir or os.environ.get("KB_TMP") or (Path(os.environ.get("KB_HOME", ".")) / "test-tmp")) / f"load-{os.getpid()}"
    base.mkdir(parents=True, exist_ok=True)
    db, sock = base / "graph.db", base / "r.sock"
    out: dict = {"errors": 0}
    try:
        t0 = time.time()
        info = build_gold(db, args.nodes, args.edges, args.units, args.overview_nodes, args.overview_edges)
        out["build_s"] = round(time.time() - t0, 1)
        out.update({k: v for k, v in info.items() if k not in ("ids_ov",)})
        ids = info["ids_ov"]
        rnd = random.Random(5)
        hub = ids[0]

        def pick():
            return hub if rnd.random() < 0.1 else ids[rnd.randrange(len(ids))]

        def terms():
            return " ".join(rnd.choices(VOCAB[:80], k=2))

        srv = Server(db, sock)
        w = Writer(db, info["last_vid"], info["last_eid"], info["applied_seq"])
        w.start()
        s = str(sock)
        try:
            from urllib.parse import quote
            for _ in range(5):                       # 웜업
                get(s, f"/v1/nodes/{quote(pick())}")
                get(s, f"/v1/search?q={quote(terms())}&limit=50")
            _, _, mb = get(s, "/v1/meta")
            meta = json.loads(mb)
            cur = meta["data"]["changes_cursor"]
            from kb.read.envelope import encode_cursor
            tail = encode_cursor({"e": meta["epoch"], "s": max(0, meta["applied_seq"] - 1000)})

            def series(name, mk, n):
                lat = []
                for _ in range(n):
                    st, ms, _b = get(s, mk())
                    if st != 200:
                        out["errors"] += 1
                        out.setdefault("failed", []).append([name, st])
                    lat.append(ms)
                out[f"{name}_p50"] = pct(lat, 50)
                out[f"{name}_p95"] = pct(lat, 95)
                out[f"{name}_p100"] = pct(lat, 100)

            n = args.reps
            series("detail", lambda: f"/v1/nodes/{quote(pick())}", n)
            series("neighbors", lambda: f"/v1/nodes/{quote(pick())}/neighbors", n)
            series("search", lambda: f"/v1/search?q={quote(terms())}&limit=50", n)
            series("facets", lambda: "/v1/facets", max(20, n // 4))
            series("facets_source", lambda: f"/v1/facets?source={quote(SOURCES[rnd.randrange(8)])}", max(20, n // 4))
            series("counts", lambda: "/v1/counts?bucket=day", max(20, n // 4))
            series("changes", lambda: f"/v1/changes?cursor={tail}&limit=500", n)
            series("nodes", lambda: f"/v1/nodes?types={OV_TYPES[rnd.randrange(5)]}&sort=label&limit=100", n)
            ov = f"/v1/overview?limit={args.overview_nodes}&edge_limit={args.overview_edges}"
            series("overview", lambda: ov, 5)
            from kb.read.ctx import iso
            mid = iso(T0 + info["claims"] // 2)
            series("overview_asof", lambda: ov + f"&as_of_observed={mid}", 5)
            _, _, ob = get(s, ov)
            od = json.loads(ob)
            out["overview_nodes_returned"] = len(od["data"]["nodes"]["rows"])
            out["overview_edges_returned"] = len(od["data"]["edges"]["rows"])
            out["overview_truncated"] = od["page"]["truncated"]
        finally:
            w.stop_ev.set()
            w.join(5)
            srv.close()
        out["write_ops"] = len(w.lat)
        out["write_p99"] = pct(w.lat, 99)
        out["write_errors"] = w.errors
        if args.cold:
            act = Activator(db, sock)
            try:
                for name, mk in (("cold_detail", lambda: f"/v1/nodes/{quote(pick())}"),
                                 ("cold_search", lambda: f"/v1/search?q={quote(terms())}&limit=50"),
                                 ("cold_overview", lambda: f"/v1/overview?limit={args.overview_nodes}&edge_limit={args.overview_edges}")):
                    lat = []
                    for _ in range(args.cold):
                        act.down()                  # 유휴 종료와 같은 상태: 서버 프로세스 없음
                        st, ms, _b = get(str(sock), mk(), timeout=120)
                        if st != 200:
                            out["errors"] += 1
                        lat.append(ms)
                    out[f"{name}_p50"] = pct(lat, 50)
                    out[f"{name}_p95"] = pct(lat, 95)
                    out[f"{name}_p100"] = pct(lat, 100)
            finally:
                act.close()
        out["cold_note"] = "서버 프로세스 기동 포함, 페이지 캐시는 데워진 상태"
    finally:
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", type=int, default=400_000)
    ap.add_argument("--edges", type=int, default=1_500_000)
    ap.add_argument("--units", type=int, default=150_000)
    ap.add_argument("--overview-nodes", type=int, default=50_000)
    ap.add_argument("--overview-edges", type=int, default=200_000)
    ap.add_argument("--cold", type=int, default=0)
    ap.add_argument("--reps", type=int, default=100)
    ap.add_argument("--dir")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    res = run(a)
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        for k, v in res.items():
            print(f"{k}: {v}")
    return 0 if not res["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
