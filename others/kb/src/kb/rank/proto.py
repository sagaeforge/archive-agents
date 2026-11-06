"""kb-rank 소켓 규약: 연결 하나에 JSON 한 줄 요청, JSON 한 줄 응답. 표준 라이브러리만 쓴다."""
from __future__ import annotations

import json
import socket
import time

MAX_LINE = 8 << 20


def recv_line(sock: socket.socket, deadline: float | None = None) -> bytes:
    buf = bytearray()
    while b"\n" not in buf:
        if deadline is not None:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("kb-rank 응답 시간 초과")
            sock.settimeout(left)
        chunk = sock.recv(1 << 16)
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_LINE:
            raise ValueError("kb-rank 응답이 너무 크다")
    return bytes(buf)


def call(path, req: dict, deadline: float) -> dict:
    """요청을 보내고 응답을 받는다. 연결 실패, 시간 초과, 형식 오류는 예외다."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("kb-rank 시간 초과")
        s.settimeout(left)
        s.connect(str(path))
        s.sendall(json.dumps(req, ensure_ascii=False).encode("utf-8") + b"\n")
        line = recv_line(s, deadline)
        out = json.loads(line.decode("utf-8"))
        if not isinstance(out, dict):
            raise ValueError("kb-rank 응답 형식 오류")
        return out
    finally:
        s.close()
