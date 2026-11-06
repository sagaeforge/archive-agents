"""결정 8 뒤 GraphQL 일괄 조회. 사용자 GitHub 자격 증명(gh)을 쓰는 safe_fetch 밖의 예외이므로 결정 8을 승인했을 때만 켠다.
수집기와 생존 판정에서만 부른다. run은 subprocess.run과 같은 호출 규약이라 시험이 가짜로 바꿀 수 있다."""
from __future__ import annotations

import json
import shutil
import subprocess

from kb.core import cas, config, ids
from kb.live.probe import Resp

BATCH = 25


def enabled(which=shutil.which) -> bool:
    return config.decision_ok(8) and which("gh") is not None


def _query(names: list) -> str:
    parts = []
    for i, n in enumerate(names):
        o, r = n.split("/", 1)
        parts.append(f'r{i}: repository(owner:{json.dumps(o)}, name:{json.dumps(r)}) {{ nameWithOwner isArchived pushedAt '
                     f'defaultBranchRef {{ target {{ ... on Commit {{ committedDate }} }} }} }}')
    return "query {" + " ".join(parts) + "}"


class GhBatch:
    """repo(name) -> Resp. 같은 배치를 한 번에 가져와 캐시한다. 결과 JSON은 CAS에 두고 스냅샷 이벤트를 쓴다."""

    def __init__(self, names: list, run=subprocess.run, source: str | None = None, write_snapshots: bool = True, timeout: int = 60):
        self.cache: dict = {}
        self.source = source
        self.calls = 0
        for i in range(0, len(names), BATCH):
            chunk = [n for n in names[i:i + BATCH] if "/" in n]
            if not chunk:
                continue
            self.calls += 1
            p = run(["gh", "api", "graphql", "-f", f"query={_query(chunk)}"], capture_output=True, text=True, timeout=timeout)
            if getattr(p, "returncode", 1) != 0 and not getattr(p, "stdout", ""):
                continue
            try:
                data = (json.loads(p.stdout).get("data") or {})
            except ValueError:
                continue
            for j, n in enumerate(chunk):
                node = data.get(f"r{j}")
                body = json.dumps(node if node else {"message": "Not Found"}, sort_keys=True).encode()
                snap = self._snapshot(n, body) if write_snapshots else None
                self.cache[n.lower()] = Resp(f"https://api.github.com/graphql?repo={n}", 200 if node else 404, body,
                                             snapshot=snap, source=source)

    def _snapshot(self, name: str, body: bytes) -> str | None:
        if not self.source:
            return None
        from kb.write import commit
        url = f"https://api.github.com/graphql?repo={name}"
        sha = cas.put(body)
        sid = ids.snapshot_id(sha, url)
        commit([{"kind": "snapshot.captured", "actor": "live", "origin": "system", "idem_key": f"snapshot:{sid}", "subject": sid,
                 "payload": {"id": sid, "document_id": ids.document_id(url), "source": self.source, "url": url, "raw_sha": sha,
                             "content_type": "application/json", "bytes": len(body), "fetched_at": int(__import__("time").time() * 1000),
                             "tier": "objects"}}], "live", timeout=60.0)
        return sid

    def repo(self, name: str) -> Resp | None:
        return self.cache.get(name.lower())
