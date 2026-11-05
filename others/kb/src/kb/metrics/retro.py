"""회고(kb retro). 입력은 수치뿐이다(레드팀 S4). 제안은 코드에 적용하지 않고 자동 커밋하지 않는다.
결과는 $KB_HOME/ops/retro/YYYY-Www.md. 시스템 운영 문서라 색인하지 않고 그래프에 넣지 않는다."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

TARGETS = ("prompt", "cadence", "vocabulary", "adapter")
# 제안 대상에서 뺀다: 소스 policy, trust, CLAUDE.md (+ 지침 파일)
EXCLUDED = re.compile(r"(policy|trust|claude\.md|host-policy|robots|tos\b|지침)", re.I)
KEY_OK = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")


def numeric_only(obj, _depth=0):
    """수치(int/float/bool)만 남긴다. 문자열 값은 버리고, 키는 짧은 식별자만 남긴다(URL처럼 보이면 버린다)."""
    if _depth > 8:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float)):
        return obj
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            k = str(k)
            if not KEY_OK.match(k) or "://" in k or k.startswith("http"):
                continue
            r = numeric_only(v, _depth + 1)
            if r is not None and r != {} and r != []:
                out[k] = r
        return out
    if isinstance(obj, (list, tuple)):
        r = [x for x in (numeric_only(i, _depth + 1) for i in obj) if isinstance(x, (int, float)) and not isinstance(x, bool)]
        return r or None
    return None


def build_input(snap: dict) -> dict:
    """snapshot에서 회고 입력을 만든다. window, 문자열 값, 원문이 들어올 수 없는 형태다."""
    body = {k: v for k, v in snap.items() if k not in ("week", "window")}
    return {"week": re.sub(r"[^0-9A-Wa-w\-]", "", str(snap.get("week", "")))[:10], "metrics": numeric_only(body) or {}}


def filter_proposals(props) -> tuple[list[dict], int]:
    """허용 대상 4종만 통과시키고 policy/trust/CLAUDE.md를 건드리는 제안은 버린다. (통과, 버린 수)."""
    keep, dropped = [], 0
    for p in props or []:
        if not isinstance(p, dict) or p.get("target") not in TARGETS:
            dropped += 1
            continue
        ch, me = str(p.get("change", "")), str(p.get("metric", ""))
        if EXCLUDED.search(ch) or EXCLUDED.search(me):
            dropped += 1
            continue
        keep.append({"target": p["target"], "change": ch[:600], "metric": me[:200]})
    return keep, dropped


def retro_path(week: str):
    from kb.core import paths
    return paths.ops_dir() / "retro" / f"{week}.md"


def write_doc(week: str, inp: dict, proposals: list[dict], dropped: int):
    p = retro_path(week)
    p.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# 회고 {week}", "",
             "시스템 운영 문서다. 색인하지 않고 지식 그래프에 넣지 않는다. 아래 제안은 코드에 적용되지 않았다.", "",
             f"제안 {len(proposals)}건, 대상 밖이라 버린 제안 {dropped}건.", ""]
    for i, q in enumerate(proposals, 1):
        lines += [f"{i}. [{q['target']}] {q['change']}", f"   근거 지표: {q['metric']}"]
    lines += ["", "## 입력 수치", "", "```json", json.dumps(inp["metrics"], ensure_ascii=False, sort_keys=True, indent=1), "```", ""]
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    os.replace(tmp, p)
    return p


def _read_archive(path: str) -> list[dict]:
    data = b""
    try:
        if path.endswith(".zst"):
            from compression import zstd
            data = zstd.decompress(open(path, "rb").read())
        else:
            import gzip
            data = gzip.open(path, "rb").read()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for ln in data.decode("utf-8", "replace").splitlines():
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


def proposals_from_events(events: list[dict]) -> list[dict]:
    for ev in reversed(events):
        if ev.get("type") == "result":
            txt = ev.get("result")
            if isinstance(txt, str):
                m = re.search(r"\{.*\}", txt, re.S)
                if m:
                    try:
                        o = json.loads(m.group(0))
                        if isinstance(o.get("proposals"), list):
                            return o["proposals"]
                    except ValueError:
                        pass
            break
    return []


def agent_cmd(inp: dict, engine: str | None = None) -> list[str]:
    from kb.core import paths
    exe = os.environ.get("KB_AGENT_RUN") or str(paths.share_dir() / "ops" / "bin" / "kb-agent-run")
    return [exe, "kb-retro", "--engine", engine or "openrouter", "--args", json.dumps({"metrics": inp["metrics"], "week": inp["week"]}, sort_keys=True, separators=(",", ":"))]


def run(snap: dict, *, dry_run: bool = False, proposals: list | None = None, timeout: float = 3600.0, engine: str | None = None) -> dict:
    """proposals가 주어지면 에이전트를 부르지 않고 그 제안을 거른다(수동 입력, 시험). 아니면 kb-agent-run kb-retro를 부른다."""
    inp = build_input(snap)
    out = {"week": inp["week"], "called": False, "skipped": None, "proposals": 0, "dropped": 0, "path": None}
    if dry_run:
        out["input"] = inp
        out["argv"] = agent_cmd(inp)[:2] + ["--args", "<수치 JSON>"]
        return out
    if proposals is None:
        if engine is None:
            from kb.commands.jobs import _engine_for
            engine = _engine_for({"cmd": "kb retro"})
        if engine is None:
            out["skipped"] = "no_api_engine"
            return out
        argv = agent_cmd(inp, engine)
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        out["called"] = True
        if p.returncode == 3:
            out["called"], out["skipped"] = False, "decision_11"
            return out
        if p.returncode != 0:
            out["skipped"] = f"agent_failed:{p.returncode}"
            return out
        try:
            arch = json.loads(p.stdout.strip().splitlines()[-1]).get("archive", "")
        except (ValueError, IndexError):
            arch = ""
        proposals = proposals_from_events(_read_archive(arch)) if arch else []
    keep, dropped = filter_proposals(proposals)
    path = write_doc(inp["week"], inp, keep, dropped)
    out.update(proposals=len(keep), dropped=dropped, path=str(path))
    return out


