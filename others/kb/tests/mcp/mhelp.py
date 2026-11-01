"""MCP 시험 도우미: 원시 JSON-RPC stdio 클라이언트(줄 단위)와 시드 데이터."""
import json
import os
import queue
import subprocess
import sys
import threading
import time

PROTO = "2025-06-18"
BOOT = "import sys; from kb.serve.mcp import main; sys.exit(main(sys.argv[1:]))"

WORDS = ("alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega apple banana cherry grape lemon mango melon "
         "olive peach pear plum berry copper silver golden marble granite cotton velvet thunder breeze harbor meadow canyon "
         "glacier lagoon orchid violet crimson").split()
DOC = ("# Claude Code hooks\n\n"
       "Claude Code hooks run shell commands on session events such as SessionStart and SessionEnd.\n\n"
       + "\n\n".join(f"The hooks setting named {w} controls a separate session event behavior and keeps a long explanatory "
                     f"sentence so that the rendered fact card is large enough to exceed a small budget." for w in WORDS)
       + "\n")


class Mcp:
    """kb-mcp 자식 프로세스 하나. 줄 단위 JSON-RPC."""

    def __init__(self, env: dict, args=(), cwd=None):
        self.p = subprocess.Popen([sys.executable, "-c", BOOT, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=env, cwd=cwd, text=True, bufsize=1)
        self.waiters = {}
        self.notes = []
        self.id = 0
        self._lock = threading.Lock()
        self._idlock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()
        self.err = []
        threading.Thread(target=lambda: [self.err.append(x) for x in self.p.stderr], daemon=True).start()

    def _pump(self):
        for ln in self.p.stdout:
            ln = ln.strip()
            if not ln:
                continue
            m = json.loads(ln)
            w = self.waiters.get(m.get("id")) if "method" not in m else None
            if w is not None:
                w.put(m)
            else:
                self.notes.append(m)

    def send(self, obj):
        with self._lock:
            self.p.stdin.write(json.dumps(obj) + "\n")
            self.p.stdin.flush()

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})})

    def rpc(self, method, params=None, timeout=15.0):
        with self._idlock:
            self.id += 1
            i = self.id
            w = self.waiters[i] = queue.Queue()
        self.send({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}})
        try:
            return w.get(timeout=timeout)
        finally:
            self.waiters.pop(i, None)
    def init(self):
        r = self.rpc("initialize", {"protocolVersion": PROTO, "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        self.notify("notifications/initialized")
        return r["result"]

    def tools(self):
        return self.rpc("tools/list")["result"]["tools"]

    def call(self, name, **args):
        """(텍스트, isError, 원 결과)."""
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        if "error" in r:
            return r["error"].get("message", ""), True, r
        res = r["result"]
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        return text, bool(res.get("isError")), res

    def read(self, uri):
        r = self.rpc("resources/read", {"uri": uri})
        if "error" in r:
            return None, r
        return "\n".join(c.get("text", "") for c in r["result"]["contents"]), r

    def close_stdin(self):
        self.p.stdin.close()

    def wait(self, timeout):
        return self.p.wait(timeout=timeout)

    def kill(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait(5)


def wait_for(fn, timeout=5.0, step=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


def fake_kb(dirpath, log):
    """호출 인자를 log 파일에 한 줄씩 남기는 가짜 kb."""
    f = dirpath / "fake-kb.sh"
    f.write_text(f'#!/bin/sh\necho "$$ $*" >> "{log}"\n')
    f.chmod(0o755)
    return str(f)


def capture(url, body: bytes, ctype="text/markdown", source="src:adhoc", fetched_at=1_793_000_000_000):
    from kb.core import cas, ids
    from kb.write import commit
    from kb.write.engine import project_pending
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": ["G"], "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    project_pending()
    return sid




def fake_kb_sid(dirpath, log):
    """호출 시각, 세션 id(sid), 인자를 남기는 가짜 kb. 분리 프로세스(setsid)인지 확인한다."""
    f = dirpath / "fake-kb-sid.sh"
    f.write_text(f'#!/bin/sh\necho "$$ $(cut -d" " -f6 /proc/$$/stat) $*" >> "{log}"\n')
    f.chmod(0o755)
    return str(f)


def lines(path):
    try:
        return [x for x in open(path).read().splitlines() if x.strip()]
    except FileNotFoundError:
        return []
