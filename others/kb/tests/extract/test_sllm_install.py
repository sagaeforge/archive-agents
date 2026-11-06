"""ops/bin/install-sllm: --dry-run은 네트워크 요청과 파일 쓰기가 0, 해시가 다른 파일은 설치 거부(exit 1)이고 부분 파일이 남지 않는다."""
import hashlib
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "ops" / "bin" / "install-sllm"


def _env(tmp, fake_curl=None):
    e = dict(os.environ, KB_TOOLCHAIN=str(tmp / "tc"), KB_MODELS=str(tmp / "models"))
    if fake_curl:
        e["PATH"] = f"{fake_curl}:{e['PATH']}"
    return e


def _tree(p: Path):
    return sorted(str(x.relative_to(p)) for x in p.rglob("*")) if p.exists() else []


def test_dry_run_prints_plan_no_network_no_writes(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "curl").write_text("#!/bin/sh\necho called >> %s/curl.log\nexit 9\n" % tmp_path)
    (bindir / "curl").chmod(0o755)
    p = subprocess.run(["bash", str(SCRIPT), "--dry-run"], capture_output=True, text=True, env=_env(tmp_path, bindir))
    assert p.returncode == 0, p.stderr
    out = p.stdout
    for need in ("NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf", "llama-b12020-bin-ubuntu-cuda-13.4-x64.tar.gz",
                 "84ff34f5834b929043f5ae74799e8d562d4056998f6a5923ceb44831e8ad84d6", "5060482240", str(tmp_path / "models" / "nemotron"),
                 str(tmp_path / "tc" / "llama")):
        assert need in out, need
    assert not (tmp_path / "curl.log").exists()                # 네트워크 요청 0
    assert not (tmp_path / "tc").exists() and not (tmp_path / "models").exists()      # 파일 쓰기 0


def _pins(tmp, src: Path, sha: str):
    f = tmp / "pins"
    f.write_text(f"{sha} {src.stat().st_size} model.gguf {src.as_uri()}\n")
    return f


def test_hash_mismatch_refuses_and_leaves_no_partial(tmp_path):
    src = tmp_path / "src.bin"
    src.write_bytes(b"hello model")
    pins = _pins(tmp_path, src, "0" * 64)
    p = subprocess.run(["bash", str(SCRIPT), "--pins", str(pins)], capture_output=True, text=True, env=_env(tmp_path))
    assert p.returncode == 1 and "해시 불일치" in p.stderr
    assert not any(n.endswith((".part", ".gguf")) for n in _tree(tmp_path / "models"))      # 대상 경로에 부분 파일이 없다
    assert not (tmp_path / "models" / "nemotron" / "model.gguf").exists()


def test_correct_hash_installs(tmp_path):
    src = tmp_path / "src.bin"
    src.write_bytes(b"hello model")
    pins = _pins(tmp_path, src, hashlib.sha256(b"hello model").hexdigest())
    p = subprocess.run(["bash", str(SCRIPT), "--pins", str(pins)], capture_output=True, text=True, env=_env(tmp_path))
    assert p.returncode == 0, p.stderr
    assert (tmp_path / "models" / "nemotron" / "model.gguf").read_bytes() == b"hello model"
    assert not list((tmp_path / "models").rglob("*.part"))


def test_pinned_hashes_match_local_manifest():
    import json
    pins = {l.split()[2]: l.split()[0] for l in (REPO / "ops/bin/install-sllm.sha256").read_text().splitlines() if l and not l.startswith("#")}
    assert len(pins) == 3 and all(len(v) == 64 for v in pins.values())
    man = Path.home() / ".cache/sagae-kb/llm-eval/models/manifest.json"
    if man.exists():
        m = json.loads(man.read_text())["nemotron-bolt-e4b"]
        assert pins[m["file"]] == m["sha256"]
