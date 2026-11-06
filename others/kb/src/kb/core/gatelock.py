"""쓰기 게이트. 호출마다 새 fd, 대기 스레드의 차단 flock, 시간 초과는 TimeoutError."""
from __future__ import annotations

import fcntl
import os
import threading
from pathlib import Path


class Gate:
    def __init__(self, path: str | os.PathLike):
        self.path = Path(path)

    def acquire(self, timeout: float = 5.0) -> int:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
        mu = threading.Lock()
        done = threading.Event()
        st = {"s": "waiting", "err": None}

        def waiter() -> None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError as e:  # fd가 이미 닫힌 경우 등
                with mu:
                    st["err"] = e
                    if st["s"] == "abandoned":  # 호출자가 떠났으므로 여기서 닫는다
                        os.close(fd)
                        return
                    st["s"] = "failed"
                done.set()
                return
            with mu:
                if st["s"] == "abandoned":
                    # 호출자가 포기했다. 늦게 얻은 잠금을 바로 푼다.
                    try:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    finally:
                        os.close(fd)
                    return
                st["s"] = "granted"
            done.set()

        t = threading.Thread(target=waiter, name="gate-wait", daemon=True)
        def leave() -> str:
            with mu:
                s = st["s"]
                if s == "waiting":
                    st["s"] = "abandoned"
                return s

        try:
            t.start()
        except BaseException:
            os.close(fd)
            raise
        try:
            done.wait(timeout)
        except BaseException:  # 호출자가 떠나도 대기 스레드가 잠금을 영구히 쥐지 않게 한다
            s = leave()
            if s == "granted":
                self.release(fd)
            elif s == "failed":
                os.close(fd)
            raise
        s = leave()
        if s == "granted":
            return fd
        if s == "failed":
            os.close(fd)
            raise OSError(f"게이트 잠금 실패: {st['err']}")
        raise TimeoutError(f"게이트 {self.path} 를 {timeout}초 안에 얻지 못함")

    def release(self, fd: int) -> None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
