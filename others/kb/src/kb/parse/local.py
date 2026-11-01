"""로컬 실행 소스(네트워크 없음). internal.d/parse.yaml의 작업이 부른다.
O07 `codex features list`: 가짜 CODEX_HOME에서 실행해 전역 ~/.codex를 건드리지 않는다. 출력은 CAS에 넣고
snapshot.captured를 쓴다(url=local://codex/features-list). 파싱은 4단계가 codex_features 어댑터로 한다."""
from __future__ import annotations

import os
import shutil
import subprocess

from kb.collect import clock
from kb.collect.state import State
from kb.core import cas, ids, paths

SOURCE = "src:codex-features"
URL = "local://codex/features-list"
ACTOR = "collector"


def codex_features(ctx=None) -> dict:
    exe = shutil.which("codex")
    if not exe:
        return {"skipped": "no_codex"}
    home = paths.kb_home() / "codex-home"
    home.mkdir(parents=True, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "CODEX_HOME": str(home), "LANG": "C.UTF-8"}
    try:
        p = subprocess.run([exe, "features", "list"], env=env, capture_output=True, timeout=45, check=False, cwd=str(home))
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"failed": f"{type(e).__name__}"}
    if p.returncode != 0 or not p.stdout.strip():
        return {"failed": f"exit={p.returncode}"}
    sha = cas.put(p.stdout)
    with State() as st:
        if st.kv_get("local:codex_features:sha") == sha:
            return {"unchanged": True}
        sid = ids.snapshot_id(sha, URL)
        payload = {"id": sid, "document_id": ids.document_id(URL), "source": SOURCE, "url": URL, "raw_sha": sha,
                   "content_type": "text/plain", "bytes": len(p.stdout), "fetched_at": clock.now_ms(), "domain": ["G"],
                   "tier": "objects"}
        from kb.write import commit
        from kb.write.errors import IdemConflict
        try:
            commit([{"kind": "snapshot.captured", "actor": ACTOR, "origin": "external", "idem_key": f"snapshot:{sid}",
                     "subject": sid, "payload": payload}], ACTOR, timeout=60.0)
        except IdemConflict:
            pass
        st.kv_set("local:codex_features:sha", sha)
    return {"captured": sid}
