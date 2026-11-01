import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "write"))
sys.path.insert(0, str(Path(__file__).parent))
"""WP-26 시험 공통. 합성 표본과 임시 KB_HOME만 쓴다. 네트워크는 막는다."""
import json
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from ihelp import FAKE_PAT, NODE


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("네트워크 호출")
    monkeypatch.setattr(socket.socket, "connect", boom)
    monkeypatch.setattr(socket, "getaddrinfo", boom)


@pytest.fixture
def env(kb_home, monkeypatch):
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    from kb.intake import deny
    copy = kb_home / "copy"
    copy.mkdir()
    deny.build(copy, {NODE})
    return kb_home


def write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def item(**kw):
    base = {"session": "sess-a", "project": "proj", "researched_on": "2026-10-31", "primary": "포함"}
    base.update(kw)
    return base


@pytest.fixture
def sample(env):
    """합성 표본 파일과 매니페스트(dict)."""
    s = env / "src"
    full = write(s / "full.md", "\n".join([
        "# 제목", "공개 문서 https://example.org/docs/a?utm_source=x&id=7#frag 참고",
        "사설 주소 192.0.2.1 접속", f"노드 {NODE} 에서 실측", "scopes: repo, admin:org", "내부 host.internal 확인",
        "http 포트 localhost:8080 사용", "정상 줄 하나", "줄8", "줄9", ""]))
    write(s / "filtered.md", "\n".join(f"line {i}" for i in range(1, 11)) + "\n")
    write(s / "secret.md", f"토큰 예시 {FAKE_PAT}\n본문\n")
    started = [{"type": "started", "key": "k1", "label": "investigate:trail"},
               {"type": "started", "key": "k2", "label": "investigate:repo"},
               {"type": "result", "key": "k1", "result": {"facts": ["trail fact https://example.net/t"]}},
               {"type": "result", "key": "k2", "result": {"facts": ["OTHER-LABEL-FACT"]}}]
    write(s / "journal.jsonl", "\n".join(json.dumps(x) for x in started) + "\n")
    tr = write(s / "transcript.jsonl", "TRANSCRIPT-BODY-SENTINEL https://example.com/never\n")
    write(env / "copy" / "urls.txt", "https://example.org/pub1\nhttps://10.x.x.x/x\nhttps://svc.internal/y\nhttps://example.org/pub1\n")
    write(s / "package-lock.json", json.dumps({"packages": {"node_modules/zod": {"version": "4.6.7"}, "node_modules/other": {"version": "9.9.9"}}}))
    write(s / "spikes" / "a.txt", "alpha\n")
    write(s / "spikes" / "sub" / "b.txt", "beta\n")
    write(s / "page.html", '<a href="https://example.org/pub2">x</a> <a href="https://192.0.2.1/z">y</a> 내부 ' + NODE)
    man = {"copy_dir": str(env / "copy"), "items": [
        item(id="i-full", path=str(full), topic="전체 문서", treat="full"),
        item(id="i-filt", path=str(s / "filtered.md"), topic="걸러낼 문서", treat="filtered", exclude_lines=[3, 5]),
        item(id="i-secret", path=str(s / "secret.md"), topic="비밀 표본", treat="full"),
        item(id="i-jsonl", path=str(s / "journal.jsonl"), topic="저널", treat="jsonl_filter", select=["investigate:trail"]),
        item(id="i-urls", path=str(tr), topic="전사", treat="urls_only", urls_file=str(env / "copy" / "urls.txt")),
        item(id="i-html", path=str(s / "page.html"), topic="html", treat="urls_only"),
        item(id="i-lock", path=str(s / "package-lock.json"), topic="잠금", treat="versions_only", select=["zod", "missing-pkg"]),
        item(id="i-idx", path=str(s / "spikes"), topic="폴더", treat="index"),
        item(id="i-ex", path=str(s / "nope.md"), topic="제외", treat="excluded", note="사유"),
    ]}
    return man, tr
