"""작성자 결정. 서버가 전송 계층에서 정한다(ADR 7.8). 입력 스키마에 author가 없다.

주의: 같은 UID 프로세스 앞에서는 실수 방지일 뿐 보안 경계가 아니다. 같은 UID의 Bash는 환경 변수와
transport 인수를 마음대로 고를 수 있다.

귀속은 쓸 때 한 번 정해 이벤트에 박는다. 멱등 비교에 on_behalf_of와 generated_by가 들어가므로
스풀 재적재와 재시도는 저장된 값을 그대로 쓰고 다시 계산하지 않는다.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

from kb.core.ids import uuid7
from kb.write import tty as _tty
from kb.write.errors import WriteRejected

USER = "user:sagae"
TRANSPORTS = ("mcp", "inbox", "cli", "intake", "http")
_SESSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}")
_PROC_SESSION = "s-" + uuid7()


@dataclass(frozen=True)
class Author:
    actor: str
    on_behalf_of: str | None
    generated_by: str | None = None


def clean_session(s: str | None) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    if not _SESSION_RE.fullmatch(s):
        raise WriteRejected("bad_session", "세션 이름 형식 위반")   # 값은 비밀일 수 있어 되돌려 주지 않는다
    return s


def process_session() -> str:
    """MCP 서버 프로세스의 귀속 단위. KB_MCP_SESSION이 있으면 그 값, 없으면 시작할 때 만든 s-<UUIDv7>."""
    env = os.environ.get("KB_MCP_SESSION")
    return clean_session(env) if env else _PROC_SESSION


def resolve(transport: str, session: str | None = None, *, tty: bool | None = None,
            token_label: str | None = None, change: str = "save") -> Author:
    if transport == "http":
        if not isinstance(token_label, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", token_label) \
                or change not in ("save", "autosave", "auto"):
            raise WriteRejected("schema_invalid", "쓰기 귀속 형식 위반")
        actor = f"app:{token_label}"
        return Author(actor, USER if change != "auto" else None, f"{actor}:{change}")
    if transport not in TRANSPORTS:
        raise WriteRejected("bad_transport", "알 수 없는 전송(mcp|inbox|cli|intake)")
    if transport == "mcp":
        return Author(f"agent:{clean_session(session) or process_session()}", USER)
    if transport == "inbox":
        return Author(USER, None)
    if transport == "cli":
        t = _tty.is_tty() if tty is None else tty
        return Author(USER, None) if t else Author("agent:cli", None)
    s = clean_session(session)
    if not s:
        raise WriteRejected("bad_session", "intake 전송은 session 인수가 필요하다")
    return Author(f"agent:{s}", USER)
