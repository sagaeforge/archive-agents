"""소켓 규약: 요청은 embed_search, rerank 둘뿐. 유휴 종료와 VRAM 해제."""
import threading
import time

from kb.rank import conf, proto, server

from .conftest import build_vec


def _call(req):
    return proto.call(conf.sock_path(), req, time.monotonic() + 5)


def test_ops_and_errors(w, kb_home, service):
    build_vec(w, kb_home)
    r = _call({"op": "embed_search", "q": "쇼츠 수익", "k": 3, "kind": "fact"})
    assert r["ok"] and len(r["ids"]) == 3 and all(i.startswith(("c-", "f-")) for i in r["ids"])
    r = _call({"op": "rerank", "q": "쇼츠 수익", "texts": ["쇼츠 수익 배분은 45%다.", "전혀 다른 문장"]})
    assert r["ok"] and r["logits"][0] > r["logits"][1]
    assert _call({"op": "other", "q": "x"})["error"] == "bad_op"
    assert _call({"op": "embed_search", "q": "x", "k": 0})["error"] == "bad_param"
    assert _call({"op": "embed_search", "q": "x", "k": 3, "kind": "zzz"})["error"] == "bad_param"
    assert _call({"op": "rerank", "q": "", "texts": []})["error"] == "bad_q"


def test_no_rerank_reports_error(w, kb_home, service):
    service.no_rerank = True
    assert _call({"op": "rerank", "q": "x", "texts": ["a"]}) == {"ok": False, "error": "no_rerank"}


def test_idle_exit_and_release(kb_home):
    svc = server.RankService(stub=True)
    lst = server.listener_from_env()
    done = threading.Event()
    t = threading.Thread(target=lambda: (server.serve(lst, svc, idle_exit_s=2.5, gpu_release_s=1.0), done.set()), daemon=True)
    t.start()
    assert _call({"op": "rerank", "q": "x", "texts": ["x"]})["ok"]
    assert svc._rr is not None
    time.sleep(1.8)
    assert svc._rr is None and svc.device is None      # 유휴에 모델을 풀었다
    assert done.wait(4)                                # 유휴 종료
    lst.close()
