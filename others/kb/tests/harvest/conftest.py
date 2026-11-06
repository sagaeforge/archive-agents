"""kb harvest 시험 공통. 합성 표본과 임시 KB_HOME만 쓴다(실운영 KB와 실제 ~/.claude는 건드리지 않는다).
네트워크와 프로세스 생성은 막는다: 수확은 둘 다 쓰지 않는다."""
import json
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "write"))   # wrhelp
sys.path.insert(0, str(Path(__file__).parent))

NODE = "zz-node-alpha"
FAKE_PAT = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"      # 모양만 같은 가짜 값
OLD = time.time() - 7 * 86400                                   # 쓰는 중이 아닌 원본


@pytest.fixture(autouse=True)
def no_network_no_process(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("네트워크나 프로세스 호출")
    monkeypatch.setattr(socket.socket, "connect", boom)
    monkeypatch.setattr(socket, "getaddrinfo", boom)
    monkeypatch.setattr(subprocess.Popen, "__init__", boom)
    monkeypatch.setattr(os, "system", boom)


@dataclass
class World:
    home: Path
    projects: Path
    repo: Path
    cfg_dir: Path

    def cfg(self, **kw):
        from kb.harvest.config import Config
        base = dict(claude_projects=str(self.projects), repos=(str(self.home / "sagae-*"),), min_age_s=0,
                    min_report_chars=100, min_result_chars=20, min_body_chars=1)
        base.update(kw)
        return Config(**base)

    # ---- 합성 원본
    def memory(self, project="-home-u-proj-a", name="note.md", body="본문 한 줄\n두 번째 줄\n", *, desc="메모 제목",
               typ="feedback", session="11111111-aaaa-bbbb-cccc-222222222222", mtime=OLD):
        p = self.projects / project / "memory" / name
        text = (f"---\nname: {Path(name).stem}\ndescription: {desc}\nmetadata:\n  node_type: memory\n  type: {typ}\n"
                f"  originSessionId: {session}\n  modified: 2026-10-31T15:28:14.273Z\n---\n\n{body}")
        return self._w(p, text, mtime)

    def journal(self, results, project="-home-u-proj-a", session="22222222-aaaa-bbbb-cccc-333333333333",
                wf="wf_demo1234", mtime=OLD):
        """results: [(label, result)]"""
        lines = [{"type": "launched"}]
        for i, (label, res) in enumerate(results):
            lines.append({"type": "started", "agentId": f"a{i}", "key": f"k{i}", "label": label, "phase": "p"})
            lines.append({"type": "result", "agentId": f"a{i}", "key": f"k{i}", "result": res, "toolsUsed": 3})
        p = self.projects / project / session / "subagents" / "workflows" / wf / "journal.jsonl"
        return self._w(p, "\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", mtime)

    def agent(self, text, project="-home-u-proj-a", session="22222222-aaaa-bbbb-cccc-333333333333",
              agent_id="adeadbeef01", agent_type="general-purpose", finished=True, description="조사 에이전트",
              stop="end_turn", pad=0, mtime=OLD):
        d = self.projects / project / session / "subagents"
        lines = [{"type": "user", "message": {"role": "user", "content": "go"}, "timestamp": "2026-10-31T10:00:00Z"}]
        lines += [{"type": "attachment", "attachment": {"blob": "x" * 200}} for _ in range(pad)]
        lines.append({"type": "assistant", "timestamp": "2026-10-31T11:00:00Z",
                      "message": {"id": "m1", "stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": "..."}]}})
        lines.append({"type": "assistant", "timestamp": "2026-10-31T11:00:01.500Z",
                      "message": {"id": "m1", "stop_reason": stop, "content": [{"type": "text", "text": text}]}})
        lines.append({"type": "attachment", "attachment": {}})
        p = self._w(d / f"agent-{agent_id}.jsonl", "\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", mtime)
        meta = {"agentType": agent_type, "description": description, "finished": True if finished else None}
        self._w(d / f"agent-{agent_id}.meta.json", json.dumps(meta), mtime)
        return p

    def doc(self, name="topic.md", text="# 조사 문서\n\n본문 내용이 여기 있다.\n", repo=None, mtime=OLD):
        r = repo or self.repo
        return self._w(r / "docs" / "research" / name, text, mtime)

    def _w(self, p: Path, text: str, mtime) -> Path:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        os.utime(p, (mtime, mtime))
        return p


@pytest.fixture
def world(kb_home, monkeypatch):
    """임시 KB_HOME, 차단 목록이 든 임시 설정 폴더, 합성 Claude 프로젝트 폴더와 저장소 체크아웃."""
    from kb.core import paths
    assert paths.kb_home().resolve() != Path("/home/user/sagae-kb-data")
    cfg_dir = kb_home / "config"
    cfg_dir.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    deny = cfg_dir / "intake-deny.txt"
    deny.write_text(f"{NODE}\n", encoding="utf-8")
    os.chmod(deny, 0o600)
    home = kb_home / "fakehome"
    repo = home / "sagae-demo"
    (repo / ".git").mkdir(parents=True)
    projects = home / ".claude" / "projects"
    projects.mkdir(parents=True)
    return World(home, projects, repo, cfg_dir)


@pytest.fixture(params=["held", "open"])
def mode(request, world):
    """first_party가 닫힌 상태(보관)와 열린 상태(원장) 양쪽에서 같은 시험을 돈다."""
    if request.param == "open":
        from wrhelp import open_fp_direct
        open_fp_direct()
    return request.param


def tree(root: Path) -> dict:
    """KB_HOME 아래 모든 파일의 (크기, 수정 시각). 쓰기 여부를 가리는 용도다."""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            st = p.stat()
            # 읽기 전용 연결이 WAL 데이터베이스를 열면 SQLite가 -shm(공유 메모리 색인)과 빈 -wal을 만든다. 데이터가 아니다
            if p.name.endswith("-shm") or (p.name.endswith("-wal") and st.st_size == 0):
                continue
            out[str(p.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


def all_bytes(root: Path) -> bytes:
    """KB_HOME 아래 모든 파일의 내용(원장 DB, 스풀, raw). 값이 어디에도 남지 않았는지 찾는 용도다."""
    chunks = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and "config" not in p.relative_to(root).parts[:1] and "fakehome" not in p.relative_to(root).parts[:1]:
            try:
                chunks.append(p.read_bytes())
            except OSError:
                pass
    return b"\n".join(chunks)
