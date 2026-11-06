import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))  # mhelp

REPO = Path(__file__).resolve().parents[2]
URL = "https://example.org/hooks"


def _base() -> Path:
    prod = Path("/home/user/sagae-kb-data").resolve()
    env = os.environ.get("KB_HOME")
    root = Path(env).resolve() if env else None
    if root is None or root == prod or prod in root.parents:
        build = os.environ.get("KB_BUILD_ROOT") or str(Path.home() / ".cache/sagae-kb/build")
        root = Path(build) / "pytest-default"
    return root / "test-tmp" / "pytest-mcp"


def make_home(mp: pytest.MonkeyPatch) -> Path:
    from kb.core import ledger
    from kb.project import rebuild
    d = _base() / uuid.uuid4().hex[:12]
    d.mkdir(parents=True)
    mp.setenv("KB_HOME", str(d))
    cfg = d / "config"
    cfg.mkdir()
    mp.setenv("KB_CONFIG_DIR", str(cfg))
    share = d / "share"
    share.mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources").symlink_to(REPO / "sources")
    mp.setenv("KB_SHARE", str(share))
    for k in ("KB_MCP_SESSION", "KB_MCP_SUPERVISED", "KB_SHIP_BIN", "KB_MCP_WATCH_S", "KB_LIVE"):
        mp.delenv(k, raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return d


def open_fp():
    from kb.write import commit
    commit([{"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system", "subject": "fp",
             "idem_key": "fp-opened:test", "payload": {"mode": "drill"}}])


def bundle(items, batch="m-1"):
    h = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": batch, "producer": "agent:kb-collector", "domain": ["E"],
         "created_at": "2026-11-01T00:00:00Z"}
    return [h, *items]


def seed(home: Path) -> dict:
    """공개 사실 41건(스냅샷 하나), 엔티티, 시리즈, first_party 레코드(public, internal, private, secret), external internal 레코드."""
    from kb import ingest
    from kb.write import commit, put_record
    from mhelp import DOC, capture
    open_fp()
    sid = capture(URL, DOC.encode())
    ent = [{"item": "entity", "ref": "e1", "key": "feature:claude-code-hooks", "type": "Feature", "label": "Claude Code hooks",
            "aliases": ["클로드 코드 훅"]}]
    assert ingest.submit(bundle(ent, "m-ent"), fetch=False).summary()["rejected"] == 0
    commit([{"kind": "survival.verdict", "actor": "agent:t", "origin": "system", "subject": "e:feature:claude-code-hooks",
             "idem_key": "seed-verdict", "payload": {"target": "e:feature:claude-code-hooks", "unit": "feature", "liveness": "alive",
                                                      "status": "active", "signals": [{"id": "M05"}], "decided_by": "agent:t"}}], "agent:t")
    from kb.write.engine import project_pending
    project_pending()
    quotes = ["Claude Code hooks run shell commands on session events such as SessionStart and SessionEnd."]
    quotes += [ln.strip() for ln in DOC.split("\n\n")[2:] if ln.strip()]
    items = []
    for n, q in enumerate(quotes):
        items.append({"item": "claim", "ref": f"c{n}", "subject": "e:feature:claude-code-hooks", "statement": q, "kind": "state",
                      "stance": "stated", "evidence": {"snapshot": sid, "quote": q}, "method": "llm"})
    rep = ingest.submit(bundle(items, "m-claims"), fetch=False)
    assert rep.summary()["rejected"] == 0 and rep.summary()["needs_review"] == 0, rep.lines[:3]
    commit([{"kind": "series.define", "actor": "collector", "origin": "external", "subject": "s:test-views", "idem_key": "series:test-views",
             "payload": {"id": "s:test-views", "label": "테스트 조회수", "metric": "views"}}], "collector")
    ids = {"snapshot": sid, "entity": "e:feature:claude-code-hooks", "series": "s:test-views"}
    for name, sens, body in (("pub", "public", "공개 노트 hooks 설명"), ("int", "internal", "내부 노트 hooks 설명"),
                             ("prv", "private", "비공개 노트 hooks 설명")):
        r = put_record({"type": "Note", "title": f"{name} 노트 hooks", "body": body, "sensitivity": sens}, f"seed-{name}", "mcp",
                       session="seed")
        assert not r.held and r.projected, r
        ids[name] = r.id
    # external 출처지만 internal인 레코드: 수집 프로필은 sensitivity로 가린다
    commit([{"kind": "record.put", "actor": "collector", "origin": "external", "subject": "f-extint", "idem_key": "seed-extint",
             "payload": {"id": "f-extint", "type": "Note", "title": "외부 내부 노트 hooks", "body": "외부지만 internal hooks", "body_format": "markdown",
                         "sensitivity": "internal"}}], "collector")
    ids["extint"] = "f-extint"
    from kb.write.engine import project_pending
    project_pending()
    return ids


@pytest.fixture(scope="module")
def kbenv():
    """모듈마다 시드된 KB_HOME 하나. 자식 프로세스용 환경은 .env다."""
    mp = pytest.MonkeyPatch()
    home = make_home(mp)
    ids = seed(home)
    env = dict(os.environ)
    obj = type("KbEnv", (), {"home": home, "ids": ids, "env": env})()
    yield obj
    mp.undo()
    shutil.rmtree(home, ignore_errors=True)


@pytest.fixture
def server(kbenv, request):
    """kb-mcp 일반 프로필 자식. 시험이 env를 바꾸려면 server_factory를 쓴다."""
    from mhelp import Mcp
    m = Mcp(dict(kbenv.env))
    m.init()
    yield m
    m.kill()


@pytest.fixture
def factory(kbenv):
    from mhelp import Mcp
    made = []

    def make(extra_env=None, args=(), init=True, cwd=None):
        e = dict(kbenv.env)
        e.update(extra_env or {})
        m = Mcp(e, args, cwd=cwd)
        made.append(m)
        if init:
            m.init()
        return m
    yield make
    for m in made:
        m.kill()
