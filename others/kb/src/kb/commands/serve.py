"""kb serve --http [--unix 경로] [--tcp 127.0.0.1:8737]: HTTP 읽기 API(WP-10).

systemd 소켓 활성화(LISTEN_FDS, fd 3부터)가 있으면 그 소켓을 쓰고, 없으면 --unix 경로에 직접 연다(기본 0600).
마지막 요청 뒤 idle초(기본 600)면 정상 종료한다. 유닛 설치는 사용자 승인 뒤의 일이고 이 명령은 유닛을 건드리지 않는다.
"""
from __future__ import annotations

import os
import socket
import sys

LOOPBACK = ("127.0.0.1", "::1", "localhost")


def systemd_sockets() -> list[socket.socket]:
    """LISTEN_PID가 이 프로세스이면 fd 3.. LISTEN_FDS개를 소켓으로 만든다."""
    try:
        pid, n = int(os.environ.get("LISTEN_PID", "0")), int(os.environ.get("LISTEN_FDS", "0"))
    except ValueError:
        return []
    if pid != os.getpid() or n < 1:
        return []
    out = []
    for fd in range(3, 3 + n):
        s = socket.socket(fileno=fd)
        s.setblocking(False)
        out.append(s)
    for k in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
        os.environ.pop(k, None)
    return out


def bind_unix(path: str) -> socket.socket:
    p = os.path.abspath(path)
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    if os.path.exists(p):
        probe = socket.socket(socket.AF_UNIX)
        try:
            probe.connect(p)
        except OSError:
            os.unlink(p)    # 아무도 듣지 않는 옛 소켓 파일
        else:
            raise SystemExit(f"kb serve: 이미 실행 중: {p}")
        finally:
            probe.close()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        s.bind(p)
    finally:
        os.umask(old)
    os.chmod(p, 0o600)
    s.listen(128)
    s.setblocking(False)
    return s


def bind_tcp(spec: str) -> socket.socket:
    host, _, port = spec.rpartition(":")
    host = host or "127.0.0.1"
    if host not in LOOPBACK:
        raise SystemExit("kb serve: --tcp는 루프백만 받는다(원격 이전은 별도 결정)")
    s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1" if host == "localhost" else host, int(port)))
    s.listen(128)
    s.setblocking(False)
    return s


def _cmd(args) -> int:
    if not args.http:
        print("kb serve: --http가 필요하다(MCP는 kb-mcp)", file=sys.stderr)
        return 2
    try:
        import uvicorn  # noqa: F401
        import starlette  # noqa: F401
    except ImportError:
        print("kb serve: serve 추가 의존성(starlette, uvicorn)이 없다", file=sys.stderr)
        return 2
    import asyncio

    from kb.serve.http import ServeConfig, build_app
    from kb.serve.idle import IdleTracker
    from kb.serve.limits import ConfigError
    try:
        cfg = ServeConfig.load(getattr(args, "db", None))
    except ConfigError as e:
        print(f"kb serve: 설정 오류: {e}", file=sys.stderr)
        return 2
    if args.idle_s is not None:
        cfg.idle_s = args.idle_s
    socks = systemd_sockets()
    created = None
    if not socks:
        from kb.core import paths
        unix = args.unix or str(paths.kb_home() / "run" / "read.sock")
        socks.append(bind_unix(unix))
        created = os.path.abspath(unix)
        if args.tcp:
            socks.append(bind_tcp(args.tcp))
    tracker = IdleTracker(None, cfg.idle_s)
    app = build_app(cfg, idle=tracker)
    import uvicorn
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="warning", access_log=False,
                                           timeout_graceful_shutdown=5, server_header=False))

    import signal

    def _quiet(signum, frame):
        """uvicorn은 종료 뒤 받은 신호를 이전 처리기로 다시 보낸다. 기본 처리기면 프로세스가 신호로 죽어
        소켓 파일 정리가 건너뛰어지므로, 정상 종료 경로가 끝까지 돌도록 조용한 처리기를 둔다."""
        server.should_exit = True

    for sg in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sg, _quiet)

    async def main():
        t = asyncio.create_task(tracker.watch(server))
        try:
            await server.serve(sockets=socks)
        finally:
            t.cancel()

    try:
        asyncio.run(main())
    finally:
        if created:
            try:
                os.unlink(created)
            except OSError:
                pass
    return 0


def register(sub) -> None:
    import argparse
    p = sub.add_parser("serve", help="HTTP 읽기 API 서버(소켓 활성화 또는 --unix)")
    p.add_argument("--http", action="store_true")
    p.add_argument("--unix", help="Unix 소켓 경로(기본 $KB_HOME/run/read.sock, 0600)")
    p.add_argument("--tcp", help="루프백 TCP host:port(선택. Bearer 필수)")
    p.add_argument("--idle-s", type=float, default=None, help="유휴 종료 초(기본 설정 read.idle_s=600)")
    p.add_argument("--db", help=argparse.SUPPRESS)
    p.set_defaults(func=_cmd)
