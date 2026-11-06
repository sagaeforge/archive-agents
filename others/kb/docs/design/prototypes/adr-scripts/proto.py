#!/usr/bin/env python3
"""ADR 실측용 프로토타입. 확정 후보 구조를 그대로 흉내 낸다.

ledger/ledger.db   FULL, 해시 체인, 추가 전용. seq는 여기서만 발급한다.
gold/<build>/graph.db  NORMAL. 파생. gold/current 는 symlink.
쓰기: 게이트 flock(대기 스레드 + 시간 제한) -> ledger COMMIT(FULL) -> gold 투영(NORMAL)
재구축: 게이트 없이 새 빌드 재생 -> 게이트 안 꼬리 따라잡기 -> symlink rename
"""
import fcntl, hashlib, json, os, random, signal, sqlite3, statistics, sys, threading, time, multiprocessing as mp
from pathlib import Path

GENESIS = "0" * 64


def now_ms():
    return time.time_ns() // 1_000_000


class Gate:
    """차단 flock을 대기 스레드에서 건다. 시간 초과면 호출자는 돌아가고 대기 스레드가 뒤처리한다."""

    def __init__(self, path):
        self.path = str(path)

    def acquire(self, timeout=5.0):
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        ev = threading.Event()
        state = {"abandoned": False}
        lock = threading.Lock()

        def waiter():
            fcntl.flock(fd, fcntl.LOCK_EX)
            with lock:
                if state["abandoned"]:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)
                    return
            ev.set()

        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        if ev.wait(timeout):
            return fd
        with lock:
            if ev.is_set():
                return fd
            state["abandoned"] = True
        raise TimeoutError("gate")

    def release(self, fd):
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def ledger_conn(root, ro=False):
    p = Path(root) / "ledger" / "ledger.db"
    if ro:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=30, isolation_level=None)
    else:
        c = sqlite3.connect(p, timeout=30, isolation_level=None)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=FULL")
    return c


def ledger_init(root):
    (Path(root) / "ledger").mkdir(parents=True, exist_ok=True)
    c = ledger_conn(root)
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INT NOT NULL, actor TEXT NOT NULL,
          kind TEXT NOT NULL, idem TEXT UNIQUE, payload BLOB NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS no_upd BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT,'append only'); END;
        CREATE TRIGGER IF NOT EXISTS no_del BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT,'append only'); END;
        """
    )
    c.close()


GOLD_DDL = """
CREATE TABLE node(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL, label TEXT NOT NULL, grp INT NOT NULL,
  val INT NOT NULL, recorded_at INT NOT NULL, expired_at INT, seq INT NOT NULL, UNIQUE(id,version));
CREATE INDEX node_cur ON node(id) WHERE expired_at IS NULL;
CREATE TABLE tot(grp INT PRIMARY KEY, sum INT NOT NULL, n INT NOT NULL);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 0");
"""


def bigrams(s):
    r = []
    for w in s.split():
        if len(w) < 2:
            r.append(w)
        for i in range(len(w) - 1):
            r.append(w[i : i + 2])
    return " ".join(r)


def gold_new(root, build):
    d = Path(root) / "gold" / build
    d.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(d / "graph.db", timeout=30, isolation_level=None)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript(GOLD_DDL)
    c.execute("INSERT INTO meta VALUES('applied_seq','0')")
    c.close()
    return d


def set_current(root, build):
    g = Path(root) / "gold"
    tmp = g / ".next"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(build, tmp)
    os.replace(tmp, g / "current")
    dfd = os.open(g, os.O_RDONLY)
    os.fsync(dfd)
    os.close(dfd)


def gold_conn(path):
    c = sqlite3.connect(path, timeout=30, isolation_level=None)
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def apply(c, seq, at, payload):
    p = json.loads(payload)
    grp, val = p["grp"], p["val"]
    row = c.execute("SELECT vid,version,val FROM node WHERE id=? AND expired_at IS NULL", (p["id"],)).fetchone()
    ver = 1
    if row:
        c.execute("UPDATE node SET expired_at=? WHERE vid=?", (at, row[0]))
        ver = row[1] + 1
        c.execute("UPDATE tot SET sum=sum-? WHERE grp=?", (row[2], grp))
    else:
        c.execute("INSERT INTO tot VALUES(?,0,0) ON CONFLICT(grp) DO UPDATE SET n=n+1", (grp,))
    cur = c.execute(
        "INSERT INTO node(id,version,label,grp,val,recorded_at,seq) VALUES(?,?,?,?,?,?,?)",
        (p["id"], ver, p["label"], grp, val, at, seq),
    )
    c.execute("INSERT INTO fts(rowid,tok) VALUES(?,?)", (cur.lastrowid, bigrams(p["label"])))
    c.execute("UPDATE tot SET sum=sum+? WHERE grp=?", (val, grp))


def project_tail(led, g, limit=None):
    """gold를 원장 꼬리까지 따라잡는다. applied_seq는 트랜잭션 안에서 읽는다."""
    g.execute("BEGIN IMMEDIATE")
    try:
        a = int(g.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0])
        q = "SELECT seq,at,payload FROM event WHERE seq>? ORDER BY seq"
        args = [a]
        if limit:
            q += " LIMIT ?"
            args.append(limit)
        n = 0
        last = a
        for seq, at, payload in led.execute(q, args).fetchall():
            apply(g, seq, at, payload)
            last = seq
            n += 1
        if n:
            g.execute("UPDATE meta SET v=? WHERE k='applied_seq'", (str(last),))
        g.execute("COMMIT")
        return n
    except BaseException:
        g.execute("ROLLBACK")
        raise


def write(root, gate, events, actor, timeout=5.0, batch_commit=True):
    fd = gate.acquire(timeout)
    try:
        led = ledger_conn(root)
        led.execute("BEGIN IMMEDIATE")
        try:
            row = led.execute("SELECT seq,hash FROM event ORDER BY seq DESC LIMIT 1").fetchone()
            prev = row[1] if row else GENESIS
            seq = row[0] if row else 0
            at = now_ms()
            out = []
            for idem, body in events:
                hit = led.execute("SELECT seq FROM event WHERE idem=?", (idem,)).fetchone()
                if hit:
                    out.append((idem, hit[0], True))
                    continue
                seq += 1
                pay = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
                h = hashlib.sha256("\n".join([prev, str(seq), str(at), actor, "put", hashlib.sha256(pay).hexdigest()]).encode()).hexdigest()
                led.execute(
                    "INSERT INTO event(seq,at,actor,kind,idem,payload,prev,hash) VALUES(?,?,?,?,?,?,?,?)",
                    (seq, at, actor, "put", idem, pay, prev, h),
                )
                prev = h
                out.append((idem, seq, False))
            led.execute("COMMIT")
        except BaseException:
            led.execute("ROLLBACK")
            raise
        g = gold_conn(Path(root) / "gold" / "current" / "graph.db")
        project_tail(led, g)
        g.close()
        led.close()
        return out
    finally:
        gate.release(fd)


def rebuild(root, build, gate, stats):
    d = gold_new(root, build)
    g = gold_conn(d / "graph.db")
    led = ledger_conn(root, ro=True)
    g.execute("PRAGMA synchronous=OFF")
    t0 = time.perf_counter()
    total = 0
    while True:
        n = project_tail(led, g, limit=5000)
        total += n
        if n < 5000:
            break
    t1 = time.perf_counter()
    held0 = time.perf_counter()
    fd = gate.acquire(30)
    held1 = time.perf_counter()
    try:
        led2 = ledger_conn(root, ro=True)
        project_tail(led2, g)
        led2.close()
        g.execute("PRAGMA synchronous=FULL")
        g.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        g.close()
        set_current(root, build)
    finally:
        held2 = time.perf_counter()
        gate.release(fd)
    stats.append({"replayed": total, "replay_s": round(t1 - t0, 3), "gate_wait_ms": round((held1 - held0) * 1e3, 2), "gate_hold_ms": round((held2 - held1) * 1e3, 2)})


def fingerprint(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    h = hashlib.blake2b(digest_size=12)
    for r in c.execute("SELECT id,version,label,grp,val,recorded_at,expired_at,seq FROM node ORDER BY id,version"):
        h.update(repr(r).encode())
    for r in c.execute("SELECT grp,sum,n FROM tot ORDER BY grp"):
        h.update(repr(r).encode())
    c.close()
    return h.hexdigest()


# ---- 부하 ----


def session_proc(root, sid, threads, rate, stop_at, ackdir, kill_safe=False):
    gate = Gate(Path(root) / "ledger" / "write.gate")
    ackf = open(Path(ackdir) / f"ack-{sid}.ndjson", "a", buffering=1)
    lock = threading.Lock()

    def run(t):
        rnd = random.Random(sid * 1000 + t)
        i = 0
        while time.time() < stop_at:
            time.sleep(rnd.expovariate(rate))
            i += 1
            key = f"s{sid}-{os.getpid()}-t{t}-{i}"
            grp = rnd.randrange(8)
            node = f"n{sid}-{t}-{rnd.randrange(200)}"
            ev = {"id": node, "grp": grp, "val": rnd.randrange(1000), "label": f"세션 기록 {i} 유튜브 쇼츠 수익 정책 메모 {key}"}
            t0 = time.perf_counter()
            try:
                r = write(root, gate, [(key, ev)], f"agent:s{sid}")
                dt = (time.perf_counter() - t0) * 1e3
                with lock:
                    ackf.write(json.dumps({"k": key, "seq": r[0][1], "ms": round(dt, 3)}) + "\n")
            except TimeoutError:
                with lock:
                    ackf.write(json.dumps({"k": key, "timeout": True}) + "\n")

    ts = [threading.Thread(target=run, args=(t,)) for t in range(threads)]
    [x.start() for x in ts]
    [x.join() for x in ts]


def promoter_proc(root, stop_at, batch, gap, res):
    gate = Gate(Path(root) / "ledger" / "write.gate")
    rnd = random.Random(7)
    i = 0
    t0 = time.perf_counter()
    while time.time() < stop_at:
        evs = []
        for _ in range(batch):
            i += 1
            evs.append((f"p-{i}", {"id": f"e{i % 40000}", "grp": rnd.randrange(8), "val": rnd.randrange(1000), "label": f"수집 문서 조각 {i} 키워드 광고 채널 시장 자료 " * 3}))
        write(root, gate, evs, "collector:x", timeout=60)
        time.sleep(gap)
    res.put(("promoted", i, round(i / (time.perf_counter() - t0))))


def reader_proc(root, stop_at, res):
    n = bad = err = 0
    lat = []
    while time.time() < stop_at:
        t0 = time.perf_counter()
        try:
            p = Path(root) / "gold" / "current" / "graph.db"
            c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5, isolation_level=None)
            c.execute("BEGIN")
            s1 = c.execute("SELECT sum(sum) FROM tot").fetchone()[0] or 0
            s2 = c.execute("SELECT coalesce(sum(val),0) FROM node WHERE expired_at IS NULL").fetchone()[0]
            c.execute("COMMIT")
            c.close()
            n += 1
            if s1 != s2:
                bad += 1
        except sqlite3.Error:
            err += 1
        lat.append((time.perf_counter() - t0) * 1e3)
        time.sleep(0.02)
    lat.sort()
    res.put(("reads", n, "mismatch", bad, "err", err, "p95_ms", round(lat[int(len(lat) * 0.95)], 2)))


def long_reader_proc(root, stop_at, hold):
    while time.time() < stop_at:
        p = Path(root) / "gold" / "current" / "graph.db"
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5, isolation_level=None)
        c.execute("BEGIN")
        c.execute("SELECT count(*) FROM node").fetchone()
        time.sleep(hold)
        c.execute("COMMIT")
        c.close()
        time.sleep(1)


def pct(a, q):
    a = sorted(a)
    return round(a[min(len(a) - 1, int(len(a) * q))], 2) if a else None


def load(root, secs, sessions, threads, rate, batch, swaps, long_hold):
    root = Path(root)
    ledger_init(root)
    gold_new(root, "b0")
    set_current(root, "b0")
    ack = root / "acks"
    ack.mkdir(exist_ok=True)
    stop = time.time() + secs
    res = mp.Queue()
    ps = [mp.Process(target=session_proc, args=(root, s, threads, rate, stop, ack)) for s in range(sessions)]
    if batch:
        ps.append(mp.Process(target=promoter_proc, args=(root, stop, batch, float(os.environ.get("KB_GAP","0.001")), res)))
    ps.append(mp.Process(target=reader_proc, args=(root, stop, res)))
    if long_hold:
        ps.append(mp.Process(target=long_reader_proc, args=(root, stop, long_hold)))
    [p.start() for p in ps]
    gate = Gate(root / "ledger" / "write.gate")
    st = []
    for i in range(swaps):
        time.sleep(secs / (swaps + 1))
        rebuild(root, f"b{i+1}", gate, st)
    [p.join() for p in ps]
    # 마지막 꼬리
    led = ledger_conn(root, ro=True)
    g = gold_conn(root / "gold" / "current" / "graph.db")
    project_tail(led, g)
    g.close()
    msgs = []
    while not res.empty():
        msgs.append(res.get())
    acks = []
    to = 0
    for f in ack.glob("ack-*.ndjson"):
        for line in open(f):
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            if j.get("timeout"):
                to += 1
            else:
                acks.append(j)
    ms = [a["ms"] for a in acks]
    have = {r[0] for r in led.execute("SELECT idem FROM event")}
    lost = [a["k"] for a in acks if a["k"] not in have]
    head = led.execute("SELECT max(seq) FROM event").fetchone()[0]
    gseq = sqlite3.connect(root / "gold" / "current" / "graph.db").execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()[0]
    # 체인 검증
    prev = GENESIS
    ok = True
    for seq, at, actor, kind, pay, pv, h in led.execute("SELECT seq,at,actor,kind,payload,prev,hash FROM event ORDER BY seq"):
        hh = hashlib.sha256("\n".join([prev, str(seq), str(at), actor, kind, hashlib.sha256(pay).hexdigest()]).encode()).hexdigest()
        if pv != prev or hh != h:
            ok = False
            break
        prev = h
    led.close()
    # 최종 지문 대 전체 재구축
    d = gold_new(root, "verify")
    g = gold_conn(d / "graph.db")
    led = ledger_conn(root, ro=True)
    t0 = time.perf_counter()
    while project_tail(led, g, limit=5000) == 5000:
        pass
    rb = time.perf_counter() - t0
    g.close()
    f1 = fingerprint(root / "gold" / "current" / "graph.db")
    f2 = fingerprint(d / "graph.db")
    print(json.dumps({
        "writes": len(ms), "timeouts": to, "p50": pct(ms, .5), "p95": pct(ms, .95), "p99": pct(ms, .99), "max": max(ms) if ms else None,
        "lost": len(lost), "events": head, "gold_applied": gseq, "chain_ok": ok, "fp_equal": f1 == f2,
        "rebuild_s": round(rb, 2), "swaps": st, "other": msgs,
        "ledger_mb": round(os.path.getsize(root/'ledger'/'ledger.db')/1e6, 1),
    }, ensure_ascii=False))


def killer(root, rounds, workers):
    """쓰기 프로세스를 무작위로 SIGKILL하고 확인 응답 유실, 체인, 지문을 본다."""
    root = Path(root)
    ledger_init(root)
    gold_new(root, "b0")
    set_current(root, "b0")
    ack = root / "acks"
    ack.mkdir(exist_ok=True)
    ctx = mp.get_context("fork")
    procs = {}
    kills = 0
    sid = 0
    deadline = time.time() + rounds * 0.25 + 30
    for r in range(rounds):
        while len(procs) < workers:
            sid += 1
            p = ctx.Process(target=session_proc, args=(root, sid, 2, 200.0, deadline, ack))
            p.start()
            procs[sid] = p
        time.sleep(random.uniform(0.05, 0.25))
        k = random.choice(list(procs))
        os.kill(procs[k].pid, signal.SIGKILL)
        procs[k].join()
        del procs[k]
        kills += 1
    for p in procs.values():
        os.kill(p.pid, signal.SIGKILL)
        p.join()
    # 복구: 다음 쓰기와 같은 절차
    led = ledger_conn(root, ro=True)
    g = gold_conn(root / "gold" / "current" / "graph.db")
    while project_tail(led, g, limit=5000) == 5000:
        pass
    g.close()
    have = {r[0] for r in led.execute("SELECT idem FROM event")}
    acks = 0
    lost = 0
    for f in ack.glob("ack-*.ndjson"):
        for line in open(f):
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue  # SIGKILL로 찢긴 줄. 확인 응답이 아니다
            if "k" in j and not j.get("timeout"):
                acks += 1
                lost += j["k"] not in have
    d = gold_new(root, "verify")
    g = gold_conn(d / "graph.db")
    while project_tail(led, g, limit=5000) == 5000:
        pass
    g.close()
    f1 = fingerprint(root / "gold" / "current" / "graph.db")
    f2 = fingerprint(d / "graph.db")
    seqs = [r[0] for r in led.execute("SELECT seq FROM event ORDER BY seq")]
    gaps = sum(1 for a, b in zip(seqs, seqs[1:]) if b != a + 1)
    print(json.dumps({"kills": kills, "acks": acks, "lost": lost, "events": len(seqs), "seq_gaps": gaps, "fp_equal": f1 == f2}))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "load":
        load(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]), float(sys.argv[9]))
    elif cmd == "kill":
        killer(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
