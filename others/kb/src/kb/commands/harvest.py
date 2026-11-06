"""kb harvest [--dry-run] [--json]: 세션이 배운 것(메모리, 워크플로우 결과, 에이전트 보고서, 조사 문서)을 기록으로 거둔다.
결정적이고 LLM과 네트워크를 쓰지 않는다. --dry-run은 읽기만 하고 아무것도 쓰지 않는다."""
from __future__ import annotations

from kb.write.cliutil import emit, fail


def cmd_harvest(args) -> int:
    from kb import harvest
    from kb.harvest.config import ConfigError
    from kb.intake.errors import IntakeError
    from kb.write.errors import WriteRejected
    try:
        cfg = harvest.load_config(
            args.config,
            repos=args.repo or None,
            claude_projects=args.claude_projects,
            max_writes=args.max_writes,
            min_age_s=args.min_age)
        if args.dry_run:
            out = harvest.plan(cfg, samples=args.samples, dump_dir=args.dump)
        else:
            if args.dump:
                return fail("E_ARGS", "--dump는 --dry-run에서만 쓴다", args.json)
            out = harvest.run(cfg, samples=args.samples)
        emit(out, args.json)
        return 0
    except ConfigError as e:
        return fail("E_CONFIG", str(e), args.json)
    except IntakeError as e:
        return fail(e.code, e.message, args.json)
    except WriteRejected as e:
        return fail(e.code, e.message, args.json)


def register(sub) -> None:
    p = sub.add_parser("harvest", help="세션 지식 자동 수확: 정화한 기록과 URL 티켓으로 거둔다(--dry-run은 쓰지 않는다)")
    p.add_argument("--dry-run", action="store_true", help="읽기만 한다. 원장, 스풀, 티켓에 쓰지 않는다")
    p.add_argument("--config", help="harvest.yaml 경로(기본 sources/internal.d/harvest.yaml)")
    p.add_argument("--claude-projects", help="Claude 프로젝트 폴더(기본 ~/.claude/projects)")
    p.add_argument("--repo", action="append", help="docs/research를 읽을 체크아웃 경로나 글롭(여러 번 가능, 기본 ~/sagae-*)")
    p.add_argument("--max-writes", type=int, help="이번 실행에서 쓸 기록(새 기록과 새 버전)의 상한")
    p.add_argument("--min-age", type=int, help="이보다 최근에 고친 원본은 미룬다(초)")
    p.add_argument("--samples", type=int, default=3, help="보고서에 싣는 표본 제목 수(본문은 싣지 않는다)")
    p.add_argument("--dump", metavar="DIR", help="--dry-run: 저장하려는 기록을 DIR에 파일로 내보낸다(검토용, KB에는 쓰지 않는다)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_harvest)
