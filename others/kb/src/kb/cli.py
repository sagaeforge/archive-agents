"""kb 진입점. kb.commands 아래 모듈을 자동 탐색해 register(subparsers)를 부른다."""
from __future__ import annotations

import argparse
import importlib
import pkgutil
import sys


def _load_commands(sub) -> None:
    import kb.commands as pkg

    for m in sorted(pkgutil.iter_modules(pkg.__path__), key=lambda x: x.name):
        name = f"{pkg.__name__}.{m.name}"
        try:
            mod = importlib.import_module(name)
            mod.register(sub)
        except (Exception, SystemExit) as e:  # 옆 패키지가 쓰는 중인 깨진 모듈이 다른 명령을 막지 않는다
            print(f"kb: 경고: 명령 모듈 {name} 건너뜀: {type(e).__name__}: {e}", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kb", description="sagae knowledge base")
    sub = p.add_subparsers(dest="command", metavar="<명령>")
    _load_commands(sub)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 2
    rc = func(args)
    return int(rc or 0)
