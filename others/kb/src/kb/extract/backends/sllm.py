"""sLLM(Nemotron, llama.cpp) 어댑터와 수명 주기(ADR-0003 6장). 상주 프로세스 0: llama-server는 `kb agent run --scope sensitive`의
자식으로만 산다. 타이머, 소켓 활성화, 유휴 대기를 두지 않는다. 네트워크 없는 이름공간(unshare -Urn) 안에서 워커와 서버를 함께 돌린다."""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

from kb.core import paths
from kb.extract import settings, state
from kb.extract.types import Job, Preflight, Result

NAME = "sllm"
PR_SET_PDEATHSIG = 1
IN_NETNS_ENV = "KB_EXTRACT_IN_NETNS"


def server_bin() -> str:
    b = settings.get("sllm.server_bin")
    if b:
        return str(b)
    tc = os.environ.get("KB_TOOLCHAIN") or str(paths.runtime_dir())
    return os.path.join(tc, "llama", "llama-server")


def model_file() -> str:
    m = settings.get("sllm.model_file")
    if m:
        return str(m)
    return os.path.join(os.environ.get("KB_MODELS") or os.path.join(os.environ.get("KB_TOOLCHAIN", ""), "..", "models"),
                        "nemotron", "NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf")


def free_vram_mib() -> int | None:
    cmd = settings.get("sllm.vram_cmd") or ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"]
    try:
        out = subprocess.run(list(cmd), capture_output=True, text=True, timeout=20).stdout.strip().splitlines()
        return int(out[0].strip()) if out else None
    except Exception:  # noqa: BLE001
        return None


def netns_argv(argv: list) -> list:
    """이름공간 안에서 argv를 돌리는 명령. lo만 올린다."""
    return ["unshare", "-Urn", "sh", "-c", "ip link set lo up && exec \"$@\"", "sh", *argv]


def in_netns() -> bool:
    return os.environ.get(IN_NETNS_ENV) == "1"


def _pdeathsig():
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass
    os.setsid()


def _http(path: str, body: dict | None, port: int, timeout: float):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


class Session:
    """llama-server 한 번의 수명. with 블록이 끝나면 TERM, 20초 뒤 KILL, 잔존 0을 확인한다."""

    def __init__(self):
        self.port = int(settings.get("sllm.port", 18080))
        self.proc: subprocess.Popen | None = None
        self.load_s: float | None = None
        self.skipped = None

    def _cmd(self) -> list:
        return [server_bin(), "-m", model_file(), "--host", "127.0.0.1", "--port", str(self.port), "-ngl", "999",
                "-c", "16384", "-np", str(int(settings.get("sllm.slots", 2))), "-cram", "0", "--no-context-shift",
                "-t", "12", "-tb", "12", "--reasoning", "off"]

    def start(self) -> bool:
        need = int(settings.get("sllm.vram_min_mib", 6144))
        free = free_vram_mib()
        state.metric("llm.sllm_vram_free_mib", free if free is not None else -1)
        if free is None or free < need:
            self.skipped = "vram"
            state.metric("llm.sllm_skipped", 1, {"why": "vram", "free": free})
            return False
        t0 = time.time()
        self.proc = subprocess.Popen(self._cmd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     preexec_fn=_pdeathsig)
        for _ in range(int(float(settings.get("sllm.health_wait_s", 120)) * 4)):
            if self.proc.poll() is not None:
                self.skipped = "server_exited"
                return False
            try:
                if _http("/health", None, self.port, 2).get("status") in ("ok", None):
                    self.load_s = round(time.time() - t0, 2)
                    state.metric("llm.sllm_load_s", self.load_s)
                    return True
            except Exception:  # noqa: BLE001
                time.sleep(0.25)
        self.skipped = "health_timeout"
        self.stop()
        return False

    def stop(self) -> int:
        """종료 후 잔존 프로세스 수(0이어야 한다)."""
        p = self.proc
        if p is None:
            return 0
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=float(settings.get("sllm.term_wait_s", 20)))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                p.wait()
        self.proc = None
        return 0 if not _alive(p.pid) else 1

    def __enter__(self):
        self.started = self.start()
        return self

    def __exit__(self, *a):
        left = self.stop()
        state.metric("llm.sllm_residual_procs", left)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ")[-1].split()[0] != "Z"
    except OSError:
        return False


class Sllm:
    name = NAME
    external = False

    def __init__(self, port: int | None = None):
        self.port = port or int(settings.get("sllm.port", 18080))

    def preflight(self) -> Preflight:
        if not settings.get("sllm.enabled", True):
            return Preflight(False, "disabled")
        if not os.path.isfile(server_bin()):
            return Preflight(False, "no_server_bin")
        if not os.path.isfile(model_file()):
            return Preflight(False, "no_model")
        return Preflight(True)

    def extract(self, job: Job, permit=None) -> Result:
        model = str(settings.get("sllm.model", "nemotron"))
        r = Result(job.window.window_id, NAME, model)
        t0 = time.time()
        try:
            msgs = [{"role": "system", "content": job.system}, {"role": "user", "content": job.user}]
            prompt = _http("/apply-template", {"messages": msgs}, self.port, 60)["prompt"]
            prompt += str(settings.get("sllm.empty_think", "<think>\n\n</think>\n\n"))
            d = _http("/completion", {"prompt": prompt, "json_schema": job.schema, "temperature": 0, "seed": 42,
                                      "n_predict": int(settings.get("sllm.n_predict", 4000)), "cache_prompt": False},
                      self.port, float(settings.get("sllm.timeout_s", 300)))
            r.raw = d.get("content")
            r.finish_reason = "length" if (d.get("stop_type") == "limit" or d.get("truncated")) else "stop"
            t = d.get("timings") or {}
            r.usage = {"input_tokens": d.get("tokens_evaluated") or t.get("prompt_n"),
                       "output_tokens": d.get("tokens_predicted") or t.get("predicted_n"),
                       "cached_input_tokens": d.get("tokens_cached"), "reasoning_tokens": 0}
            r.provider, r.served_model, r.cost_usd = "local", model, 0.0
        except Exception as e:  # noqa: BLE001
            r.error = f"{type(e).__name__}: {str(e)[:200]}"
        r.elapsed_s = round(time.time() - t0, 3)
        return r


LEVELS = {"public": 0, "internal": 1, "private": 2, "secret": 3}


def raise_only(current: str, proposed: str | None) -> str:
    """민감도 보조 분류는 올리기만 한다. 낮추는 제안과 알 수 없는 값은 현재 등급을 유지한다."""
    if proposed in LEVELS and LEVELS[proposed] > LEVELS.get(current, 0):
        return proposed
    return current
