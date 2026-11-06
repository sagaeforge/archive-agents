"""TTY 판정. 시험이 바꿀 수 있게 한 곳에 둔다."""
from __future__ import annotations

import sys


def is_tty() -> bool:
    try:
        return bool(sys.stdin.isatty() and sys.stdout.isatty())
    except (ValueError, AttributeError):
        return False
