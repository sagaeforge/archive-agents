"""kb agent run [--scope public|sensitive] [--max-windows N] [--reextract] [--json]. L2 추출(WP-19).
sensitive는 sLLM만 쓰고 네트워크 없는 이름공간 안에서 돈다. fp_open 전에는 창 0건과 사유를 돌려준다."""
from __future__ import annotations

import json
import os
import subprocess
import sys

FIELDS = ("windows", "claims", "rejected", "queue_left", "is_error", "scope", "by_backend")


def _emit(out: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
        return
    for k, v in out.items():
        print(f"{k}: {v}")


def _sensitive_in_netns(args) -> dict | None:
    """이름공간 안에서 자기 자신을 다시 부른다. 이미 안이거나 설정이 꺼져 있으면 None(그 자리에서 돈다)."""
    from kb.extract import settings
    from kb.extract.backends import sllm
    if sllm.in_netns() or not settings.get("sllm.netns", True):
        return None
    argv = [sys.executable, "-m", "kb", "agent", "run", "--scope", "sensitive", "--json"]
    if args.max_windows is not None:
        argv += ["--max-windows", str(args.max_windows)]
    env = dict(os.environ, **{sllm.IN_NETNS_ENV: "1"})
    p = subprocess.run(sllm.netns_argv(argv), capture_output=True, text=True, env=env)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"windows": 0, "claims": 0, "rejected": 0, "queue_left": 0, "is_error": True, "scope": "sensitive",
                "by_backend": {}, "reason": f"netns_failed rc={p.returncode}: {p.stderr.strip()[:160]}"}


def cmd_run(args) -> int:
    from kb.extract import runner
    out = None
    if args.scope == "sensitive":
        out = _sensitive_in_netns(args)
    if out is None:
        try:
            out = runner.run_agent(args.scope, max_windows=args.max_windows, reextract=args.reextract,
                                   snapshot=args.snapshot, do_cross=args.cross)
        except Exception as e:  # noqa: BLE001
            out = {"windows": 0, "claims": 0, "rejected": 0, "queue_left": 0, "is_error": True, "scope": args.scope,
                   "by_backend": {}, "reason": f"{type(e).__name__}: {str(e)[:200]}"}
    _emit(out, args.json)
    return 1 if out.get("is_error") else 0


def register(sub) -> None:
    p = sub.add_parser("agent", help="L2 추출 에이전트")
    s = p.add_subparsers(dest="agent_cmd", metavar="<하위>")
    r = s.add_parser("run", help="큐의 문단을 추출한다")
    r.add_argument("--scope", choices=("public", "sensitive"), default="public")
    r.add_argument("--max-windows", type=int, default=None)
    r.add_argument("--reextract", action="store_true", help="같은 문단을 새 extractor로 다시 뽑고 옛 주장을 철회한다")
    r.add_argument("--snapshot", default=None, help="--reextract 대상 스냅샷")
    r.add_argument("--cross", action="store_true", help="주간 교차 확인 표본 감사도 돈다")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_run)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
