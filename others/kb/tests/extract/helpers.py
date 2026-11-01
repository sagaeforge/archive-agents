"""WP-19 시험 공용. 외부 호출은 전부 가짜다: 기록된 응답(가짜 claude 실행 파일), 가짜 OpenRouter 서버, 가짜 llama-server."""
from __future__ import annotations

import http.server
import json
import os
import stat
import sys
import threading
from pathlib import Path

from kb.core import cas, ids
from kb.extract.types import Result

REPO = Path(__file__).resolve().parents[2]
DOC = ("# 샘플 도구 안내\n\n"
       "샘플도구 2.0은 2026-10-01에 출시되었다. 이 버전부터 기본 제한은 10000건이다.\n\n"
       "샘플도구는 하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다.\n\n"
       "샘플도구 3.0은 2027-01-15부터 새 요금제를 적용한다고 발표되었다.\n")


def seed_env(kb_home, monkeypatch, with_key: bool = False):
    cfg = kb_home / "config"
    cfg.mkdir(exist_ok=True)
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    share.mkdir(exist_ok=True)
    for n in ("schemas", "sources", "prompts"):
        if not (share / n).exists():
            (share / n).symlink_to(REPO / n)
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    monkeypatch.delenv("KB_EXTRACT_NOW", raising=False)
    monkeypatch.delenv("KB_EXTRACT_IN_NETNS", raising=False)
    from kb.core import ledger
    from kb.project import rebuild
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    if with_key:
        (cfg / "openrouter.key").write_text("test-key-not-real\n")
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def capture(url: str, body: bytes, source: str = "src:adhoc", ctype: str = "text/markdown", domain=("G",),
            fetched_at: int = 1_793_000_000_000) -> str:
    from kb.write import commit
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": list(domain), "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    return sid


def put_entity(eid: str, label: str, typ: str = "Tool", aliases=(), domain=("G",), liveness: str | None = "alive"):
    from kb.write import commit
    p = {"id": eid, "type": typ, "label": label, "domain": list(domain), "aliases": list(aliases)}
    if liveness:
        p["liveness"] = {"state": liveness, "liveness": liveness, "status": "active"}
    commit([{"kind": "entity.put", "actor": "t", "origin": "external", "subject": eid, "idem_key": f"t:ent:{eid}",
             "payload": p}], "t")


def ingest_doc(url: str = "https://example.test/doc.md", text: str = DOC, source: str = "src:adhoc", domain=("G",),
               fetched_at: int = 1_793_000_000_000, enqueue: bool = True) -> str:
    """스냅샷을 받고 표시 본문과 문단을 만들고(snapshot.text) gold에 투영한 뒤 L2 큐에 넣는다. 반환: 스냅샷 ID."""
    from kb.extract import tick_stage
    from kb.ingest.process import Processor
    from kb.write.engine import project_pending
    sid = capture(url, text.encode("utf-8"), source, domain=domain, fetched_at=fetched_at)
    project_pending()
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=True)
    try:
        proc.text_of(proc.snapshot_info(sid))
    finally:
        proc.gold.close()
    project_pending()
    if enqueue:
        tick_stage.enqueue_new()
    return sid


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path(), 30.0)


def claims(where: str = "1=1", args=()) -> list:
    con = gold()
    try:
        return con.execute("SELECT n.id, n.status, n.verification, n.sensitivity, c.statement, c.extractor, c.kind FROM node n "
                           "JOIN claim c ON c.vid=n.vid WHERE n.type='Claim' AND n.expired_at IS NULL AND " + where +
                           " ORDER BY n.id", args).fetchall()
    finally:
        con.close()


def queue_n(kind: str = "l2") -> int:
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        return c.execute("SELECT count(*) FROM queue WHERE kind=?", (kind,)).fetchone()[0]
    finally:
        c.close()


def events(kind: str) -> list:
    from kb.core import ledger
    led = ledger.open_ledger()
    try:
        return [e["payload"] for e in ledger.iter_events(led, 0, 100000) if e["kind"] == kind]
    finally:
        led.close()


def claim_obj(subject: str, quote: str, statement: str, **kw) -> dict:
    d = {"subject": subject, "subject_new": None, "predicate": None, "statement": statement, "quote": quote, "kind": "state",
         "stance": "stated", "speaker": None, "value": None, "unit": None, "valid_from": None, "qualifier": None,
         "prior_value": None, "changed_on": None, "depends_on": None}
    d.update(kw)
    return d


GOOD = {"quote": "샘플도구는 하루 최대 500건의 요청을 지원한다", "statement": "샘플도구는 하루 최대 500건의 요청을 지원한다."}


class Fake:
    """가짜 백엔드. responder(job) -> 객체. 호출 수와 받은 작업을 기록한다."""

    def __init__(self, name: str, external: bool, responder=None, *, cost: float | None = None, model: str = "fake",
                 preflight_ok: bool = True, error: str | None = None, rate=None):
        self.name, self.external = name, external
        self.responder = responder or (lambda job: {"claims": []})
        self.calls: list = []
        self.cost, self.model, self.ok, self.error, self.rate = cost, model, preflight_ok, error, rate

    def preflight(self):
        from kb.extract.types import Preflight
        return Preflight(self.ok, "" if self.ok else "fake_off", info={"rate": {"five_hour": 0.1, "seven_day": 0.1}})

    def extract(self, job, permit):
        from kb.extract import guard
        if self.external:
            guard.verify(permit, self.name, job.user)
        self.calls.append(job)
        r = Result(job.window.window_id, self.name, job.model or self.model, served_model=self.model, provider="p",
                   finish_reason="stop", elapsed_s=0.01, cost_usd=self.cost, usage={"input_tokens": 1, "output_tokens": 1})
        if self.error:
            r.error = self.error
            return r
        r.raw = json.dumps(self.responder(job), ensure_ascii=False)
        if self.rate:
            r.extra["rate"] = self.rate
        return r


def extract_all(subject: str):
    """창 본문에서 GOOD 인용구가 있으면 그 주장을 낸다."""
    def f(job):
        if job.purpose == "support":
            return {"supported": True}
        if GOOD["quote"] in job.window.text:
            return {"claims": [claim_obj(subject, GOOD["quote"], GOOD["statement"], predicate="quota", value="500", unit="건")]}
        return {"claims": []}
    return f


# ----------------------------------------------------------------- 가짜 OpenRouter 서버
class OrServer:
    def __init__(self, responder=None, cost: float = 0.03, balance: float = 100.0, status: int = 200):
        self.requests: list = []
        self.responder = responder or (lambda body: {"claims": []})
        self.cost, self.balance, self.status = cost, balance, status
        self.delay = 0.0                 # 응답 전 대기(초). 시간 초과 시험용
        self.raw: bytes | None = None    # 있으면 본문 대신 이 바이트를 200으로 보낸다(디코딩 실패 시험용)
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                outer.requests.append(("GET", self.path, None))
                if self.path.startswith("/credits"):
                    self._send(200, {"data": {"total_credits": outer.balance + 1.0, "total_usage": 1.0}})
                else:
                    self._send(404, {})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.requests.append(("POST", self.path, body))
                if outer.delay:
                    import time
                    time.sleep(outer.delay)
                if outer.raw is not None:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(outer.raw)))
                    self.end_headers()
                    self.wfile.write(outer.raw)
                    return
                if outer.status != 200:
                    self._send(outer.status, {"error": {"message": "x", "code": outer.status}})
                    return
                out = outer.responder(body)
                self._send(200, {"id": "g-1", "model": body.get("model"), "provider": "OpenAI",
                                 "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(out, ensure_ascii=False)}}],
                                 "usage": {"prompt_tokens": 100, "completion_tokens": 50, "cost": outer.cost}})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def posts(self):
        return [r for r in self.requests if r[0] == "POST"]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


# ----------------------------------------------------------------- 가짜 claude 실행 파일
FAKE_CLAUDE = r'''#!{py}
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
if argv[:2] == ["auth", "status"]:
    print(json.dumps({{"loggedIn": True}})); sys.exit(0)
stdin = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({{"argv": argv, "stdin": stdin, "env": dict(os.environ)}}) + "\n")
cfg = json.load(open(os.path.join(here, "cfg.json")))
out = cfg.get("out")
if "--json-schema" in argv and json.loads(argv[argv.index("--json-schema") + 1]).get("required") == ["supported"]:
    out = cfg.get("support_out", {{"supported": True}})
rate = {{"status": "allowed", "isUsingOverage": cfg.get("overage", False),
         "unifiedWindows": {{"five_hour": {{"utilization": cfg.get("five_hour", 0.1)}}, "seven_day": {{"utilization": cfg.get("seven_day", 0.1)}}}}}}
if cfg.get("no_rate"):
    rate = {{"status": "allowed"}}
print(json.dumps({{"type": "system", "subtype": "init", "tools": []}}))
print(json.dumps({{"type": "rate_limit_event", "rate_limit_info": rate}}))
print(json.dumps({{"type": "result", "subtype": "success", "is_error": cfg.get("is_error", False), "permission_denials": cfg.get("denials", []),
  "structured_output": out if out is not None else {{"claims": []}}, "total_cost_usd": 0.004, "num_turns": 1,
  "usage": {{"input_tokens": 10, "output_tokens": 5}}, "modelUsage": {{"claude-haiku-5": {{}}}}}}))
'''


def make_fake_claude(dirpath: Path, out=None, **cfg) -> Path:
    dirpath.mkdir(parents=True, exist_ok=True)
    p = dirpath / "claude"
    p.write_text(FAKE_CLAUDE.format(py=sys.executable))
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    set_fake_claude(p, out, **cfg)
    return p


def set_fake_claude(p: Path, out=None, **cfg):
    cfg["out"] = out
    (p.parent / "cfg.json").write_text(json.dumps(cfg))


def fake_claude_calls(p: Path) -> list:
    f = p.parent / "calls.jsonl"
    return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []


def requeue_all(sid: str) -> int:
    """done 표시를 지우지 않고 스냅샷의 문단을 큐에 다시 넣는다(같은 큐를 다시 돌리는 상황)."""
    from kb.core import opsdb
    from kb.extract import windows
    con = gold()
    try:
        props = json.loads(con.execute("SELECT props FROM node WHERE id=? AND expired_at IS NULL", (sid,)).fetchone()[0])
    finally:
        con.close()
    paras = json.loads(cas.get(props["paras_sha"]).decode())
    c = opsdb.connect()
    try:
        return sum(opsdb.queue_put(c, "l2", windows.ref_of(sid, x["para_sha"], x["start_cp"]), domain="G") for x in paras)
    finally:
        c.close()


# ----------------------------------------------------------------- 가짜 llama-server
FAKE_LLAMA = r'''#!{py}
import http.server, json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
port = int(argv[argv.index("--port") + 1])
open(os.path.join(here, "pid"), "w").write(str(os.getpid()))
open(os.path.join(here, "starts"), "a").write("x")
open(os.path.join(here, "argv.json"), "w").write(json.dumps(argv))
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send({{"status": "ok"}})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{{}}")
        with open(os.path.join(here, "reqs.jsonl"), "a") as f:
            f.write(json.dumps({{"path": self.path, "body": body}}) + "\n")
        if self.path == "/apply-template":
            self._send({{"prompt": "".join(m["content"] for m in body["messages"])}})
        else:
            cfg = json.load(open(os.path.join(here, "cfg.json")))
            self._send({{"content": cfg.get("content", '{{"claims": []}}'), "stop_type": "eos", "tokens_evaluated": 10, "tokens_predicted": 5}})
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
'''


def make_fake_llama(d: Path, content=None) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    p = d / "llama-server"
    p.write_text(FAKE_LLAMA.format(py=sys.executable))
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    (d / "model.gguf").write_text("x")
    (d / "cfg.json").write_text(json.dumps({"content": json.dumps(content if content is not None else {"claims": []}, ensure_ascii=False)}))
    return p


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        return Path(f"/proc/{pid}/stat").read_text().split(") ")[-1].split()[0] != "Z"
    except OSError:
        return False
