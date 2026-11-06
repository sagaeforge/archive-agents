"""first_batch.jsonl이 가리키는 스냅샷을 현재 KB_HOME의 CAS와 원장에 넣는다(멱등). 스냅샷 ID는 원본 바이트와 URL의
함수라 고정이다. 실행: source ops/bin/wp-env.sh WP-08 && ops/bin/dev python tests/ingest/fixtures/seed_first_batch.py
시험에서는 seed()를 직접 부른다."""
from __future__ import annotations

from pathlib import Path

from kb.core import cas, ids

HERE = Path(__file__).resolve().parent
SNAPS = [
    ("https://code.claude.com/docs/en/commands.md", "docs/commands.md", "text/markdown", "src:cc-docs-en"),
    ("https://github.com/continuedev/continue/releases/tag/v2.0.0", "docs/continue-release.md", "text/markdown", "src:adhoc"),
    ("https://kworb.net/youtube/trending/kr.html", "docs/kworb-chart.txt", "text/plain", "src:kworb"),
]
FETCHED_AT = 1_793_000_000_000


def seed(fetched_at: int = FETCHED_AT) -> dict:
    from kb.write import commit
    from kb.write.engine import project_pending
    out = {}
    for url, rel, ctype, source in SNAPS:
        body = (HERE / rel).read_bytes()
        sha = cas.put(body)
        sid = ids.snapshot_id(sha, url)
        p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha,
             "content_type": ctype, "bytes": len(body), "fetched_at": fetched_at, "domain": ["G"], "tier": "objects"}
        commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
                 "subject": sid, "payload": p}], "collector")
        out[url] = sid
    project_pending()                 # gold가 아직 없으면 만들고 원장 머리까지 따라잡는다
    return out


if __name__ == "__main__":
    for u, s in seed().items():
        print(s, u)
