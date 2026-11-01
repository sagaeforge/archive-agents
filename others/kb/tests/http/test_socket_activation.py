"""소켓 활성화: systemd-socket-activate로 Unix 소켓 기동, 유휴 종료, 재기동. 실제 사용자 매니저를 건드리지 않는다."""
import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys

import pytest

from httphelp import uds_get, wait_for

pytestmark = pytest.mark.skipif(shutil.which("systemd-socket-activate") is None, reason="systemd-socket-activate 없음")


def _kb_cmd(db, idle):
    return [sys.executable, "-m", "kb", "serve", "--http", "--idle-s", str(idle), "--db", str(db)]


def _server_pids(db):
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                cmd = open(f"/proc/{d}/cmdline", "rb").read().split(b"\0")
            except OSError:
                continue
            if b"serve" in cmd and str(db).encode() in cmd and b"systemd-socket-activate" not in cmd[0]:
                out.append(int(d))
    return out


def test_systemd_socket_activate_tool_idle_exit_and_relaunch(world, kb_home):
    """systemd-socket-activate는 자식이 끝나면 함께 끝난다. 유휴 종료 뒤 다시 띄워도 첫 요청이 성공한다."""
    sock = str(kb_home / "a.sock")

    def launch():
        if os.path.exists(sock):
            os.unlink(sock)
        act = subprocess.Popen(["systemd-socket-activate", "-l", sock, *_kb_cmd(world.path, 1.5)],
                               stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        assert wait_for(lambda: os.path.exists(sock), 10)
        return act

    act = launch()
    try:
        assert _server_pids(world.path) == []          # 첫 연결 전에는 서버가 없다
        st, h, body = uds_get(sock, "/v1/meta")
        assert st == 200 and json.loads(body)["data"]["contract"] == "v1"
        assert wait_for(lambda: _server_pids(world.path), 5)
        assert act.wait(20) == 0                        # 요청이 없으면 유휴 종료되고 활성화 도구도 끝난다
        assert _server_pids(world.path) == []
        act = launch()
        st2, _, body2 = uds_get(sock, "/v1/nodes/e:feature:history")     # 재기동 뒤 첫 요청
        assert st2 == 200 and json.loads(body2)["data"]["id"] == "e:feature:history"
        assert uds_get(sock, "/v1/meta", {"Host": "evil.example"})[0] == 403
    finally:
        for pid in _server_pids(world.path):
            os.kill(pid, signal.SIGTERM)
        act.terminate()
        act.wait(10)


class Holder:
    """systemd의 Accept=no 소켓 유닛 흉내: 소켓을 계속 쥐고 있다가 연결이 오면 자식을 fd 3, LISTEN_FDS로 띄운다."""

    def __init__(self, sock_path, cmd):
        import select
        import threading
        self.cmd, self.child, self.spawns, self.stop = cmd, None, 0, False
        self.lsock = socket.socket(socket.AF_UNIX)
        self.lsock.bind(sock_path)
        self.lsock.listen(16)
        self.select = select

        def loop():
            while not self.stop:
                r, _, _ = select.select([self.lsock], [], [], 0.1)
                if r and (self.child is None or self.child.poll() is not None):
                    self.spawn()
                    while not self.stop and self.child.poll() is None and r:
                        r, _, _ = select.select([self.lsock], [], [], 0)   # 자식이 받아 가기를 기다린다
                        import time
                        time.sleep(0.05)
                        break
        self.t = threading.Thread(target=loop, daemon=True)
        self.t.start()

    def spawn(self):
        fd = self.lsock.fileno()
        self.child = subprocess.Popen(["sh", "-c", 'exec env LISTEN_PID=$$ LISTEN_FDS=1 "$@"', "sh", *self.cmd],
                                      preexec_fn=lambda: (os.dup2(fd, 3), os.set_inheritable(3, True)),
                                      close_fds=False, stderr=subprocess.DEVNULL)
        self.spawns += 1

    def close(self):
        self.stop = True
        self.t.join(2)
        if self.child and self.child.poll() is None:
            self.child.terminate()
            self.child.wait(10)
        self.lsock.close()


def test_persistent_socket_idle_exit_then_cold_restart(world, kb_home):
    sock = str(kb_home / "h.sock")
    h = Holder(sock, _kb_cmd(world.path, 1.5))
    try:
        assert uds_get(sock, "/v1/meta")[0] == 200
        assert h.spawns == 1
        assert wait_for(lambda: h.child.poll() is not None, 20) and h.child.returncode == 0     # 유휴 종료
        st, _, body = uds_get(sock, "/v1/nodes/e:feature:history")                               # 소켓은 그대로, 콜드 기동
        assert st == 200 and h.spawns == 2
    finally:
        h.close()


def test_direct_unix_mode_perms_sigterm(world, kb_home):
    sock = str(kb_home / "d.sock")
    p = subprocess.Popen([*_kb_cmd(world.path, 600), "--unix", sock], stderr=subprocess.PIPE, text=True)
    try:
        assert wait_for(lambda: os.path.exists(sock), 15), p.stderr.read() if p.poll() is not None else "소켓 없음"
        assert stat.S_IMODE(os.stat(sock).st_mode) == 0o600
        st, _, body = uds_get(sock, "/v1/meta")
        assert st == 200
        assert uds_get(sock, "/v1/nodes/e:feature:history", method="HEAD")[0] == 200
        p.send_signal(signal.SIGTERM)
        assert p.wait(15) == 0
        assert not os.path.exists(sock)
    finally:
        if p.poll() is None:
            p.kill()


def test_direct_mode_idle_exit(world, kb_home):
    sock = str(kb_home / "i.sock")
    p = subprocess.Popen([*_kb_cmd(world.path, 1), "--unix", sock], stderr=subprocess.DEVNULL)
    try:
        assert wait_for(lambda: os.path.exists(sock), 15)
        assert uds_get(sock, "/v1/meta")[0] == 200
        assert p.wait(15) == 0
    finally:
        if p.poll() is None:
            p.kill()


def test_real_tcp_listener_requires_token(world, kb_home):
    from kb.serve.http import create_token
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    sock = str(kb_home / "t.sock")
    p = subprocess.Popen([*_kb_cmd(world.path, 600), "--unix", sock, "--tcp", f"127.0.0.1:{port}"], stderr=subprocess.DEVNULL)
    try:
        assert wait_for(lambda: os.path.exists(sock), 15)
        import http.client
        tok = create_token("viewer")

        def tcp(headers):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            c.request("GET", "/v1/meta", headers=headers)
            r = c.getresponse()
            return r.status, r.read()
        assert wait_for(lambda: uds_get(sock, "/v1/meta")[0] == 200, 15)       # 서버가 요청을 받을 때까지
        assert tcp({})[0] == 401
        assert tcp({"Authorization": "Bearer bad"})[0] == 401
        assert tcp({"Authorization": f"Bearer {tok}"})[0] == 200
        assert tcp({"Authorization": f"Bearer {tok}", "Host": "evil.example"})[0] == 403
        assert uds_get(sock, "/v1/meta")[0] == 200            # Unix 소켓은 무토큰
        p.send_signal(signal.SIGTERM)
        assert p.wait(15) == 0
    finally:
        if p.poll() is None:
            p.kill()
