"""kb-rank 서비스: Unix 소켓 + JSON 한 줄. 요청은 embed_search(q, k, kind), rerank(q, texts) 둘뿐이다.
systemd 소켓 활성화(Accept=no, LISTEN_FDS)를 받거나 직접 바인드한다. 유휴 15분에 종료하고, 5분 유휴면 가중치와 VRAM을 푼다.
공개 ID 목록과 로짓만 돌려준다. 필터는 호출자(코어)가 다시 건다. 이 프로세스는 gold를 열지 않는다."""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from kb.rank import conf, proto, store  # noqa: E402

KIND_LETTERS = {"fact": conf.FACT, "passage": "p", "entity": "e", "any": "crep"}


class RankService:
    def __init__(self, *, stub: bool | None = None, no_rerank: bool | None = None):
        self.stub = conf.stub() if stub is None else stub
        self.no_rerank = (os.environ.get("KB_RANK_NO_RERANK") == "1") if no_rerank is None else no_rerank
        self.device: str | None = None
        self._emb = self._rr = None
        self._index = None
        self._qcache: tuple[str, bytes] | None = None
        self.last_used = time.monotonic()

    # ---- 모델
    def _ensure_device(self) -> str:
        if self.device is None:
            from kb.rank import models
            self.device = "stub" if self.stub else models.pick_device()
        return self.device

    def embedder(self):
        if self._emb is None:
            from kb.rank import models
            self._emb = models.StubEmbedder() if self.stub else models.Embedder(conf.model_path("embed"), self._ensure_device())
        return self._emb

    def reranker(self):
        if self.no_rerank or self._ensure_device() == "cpu":
            return None
        if self._rr is None:
            from kb.rank import models
            self._rr = models.StubReranker() if self.stub else models.Reranker(conf.model_path("rerank"), self.device)
        return self._rr

    def release(self) -> None:
        """다른 세션과 GPU를 나누므로 유휴에 가중치를 푼다. 다음 요청에 다시 올린다."""
        for m in (self._emb, self._rr):
            if m is not None and hasattr(m, "close"):
                m.close()
        self._emb = self._rr = None
        self.device = None
        self._qcache = None

    # ---- 색인
    def index(self):
        cur = store.current_root()
        if cur is None:
            self._index = None
        elif self._index is None or self._index.root != cur:
            self._index = store.Index(cur)
        return self._index

    # ---- 요청
    def handle(self, req: dict) -> dict:
        self.last_used = time.monotonic()
        op = req.get("op")
        q = req.get("q")
        if not isinstance(q, str) or not q.strip():
            return {"ok": False, "error": "bad_q"}
        if op == "embed_search":
            k, kind = req.get("k"), req.get("kind", "any")
            if not isinstance(k, int) or isinstance(k, bool) or not 1 <= k <= 200 or kind not in KIND_LETTERS:
                return {"ok": False, "error": "bad_param"}
            idx = self.index()
            if idx is None:
                return {"ok": True, "ids": [], "build": None, "device": self._ensure_device()}
            if self._qcache is None or self._qcache[0] != q:
                self._qcache = (q, self.embedder().encode_q8([q], "query")[0])
            return {"ok": True, "ids": idx.topk(self._qcache[1], k, KIND_LETTERS[kind]), "build": idx.build, "device": self._ensure_device()}
        if op == "rerank":
            texts = req.get("texts")
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts) or len(texts) > 500:
                return {"ok": False, "error": "bad_param"}
            rr = self.reranker()
            if rr is None:
                return {"ok": False, "error": "no_rerank"}
            return {"ok": True, "logits": rr.score(q, texts) if texts else [], "device": self.device}
        return {"ok": False, "error": "bad_op"}


def listener_from_env() -> socket.socket:
    if os.environ.get("LISTEN_PID") == str(os.getpid()) and int(os.environ.get("LISTEN_FDS", "0")) >= 1:
        return socket.socket(fileno=3)
    p = conf.sock_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if p.exists() or p.is_symlink():
        p.unlink()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(p))
    os.chmod(p, 0o600)
    s.listen(8)
    return s


def serve(listener: socket.socket, svc: RankService, *, idle_exit_s: float = conf.IDLE_EXIT_S,
          gpu_release_s: float = conf.GPU_RELEASE_S, stop=lambda: False) -> None:
    listener.settimeout(1.0)
    svc.last_used = time.monotonic()
    while not stop():
        idle = time.monotonic() - svc.last_used
        if idle >= idle_exit_s:
            return
        if idle >= gpu_release_s and (svc._emb is not None or svc._rr is not None):
            svc.release()
        try:
            c, _ = listener.accept()
        except socket.timeout:
            continue
        with c:
            try:
                line = proto.recv_line(c, time.monotonic() + 10)
                req = json.loads(line.decode("utf-8"))
                res = svc.handle(req) if isinstance(req, dict) else {"ok": False, "error": "bad_request"}
            except Exception as e:  # noqa: BLE001 한 요청의 실패가 서비스를 죽이지 않는다
                res = {"ok": False, "error": f"{type(e).__name__}"}
            try:
                c.sendall(json.dumps(res, ensure_ascii=False).encode("utf-8") + b"\n")
            except OSError:
                pass


def main() -> int:
    svc = RankService()
    lst = listener_from_env()
    try:
        serve(lst, svc)
    finally:
        svc.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
