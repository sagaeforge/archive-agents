"""oasdiff 1.35.0: 기준선(docs/contracts/baseline/openapi.yaml) 대비 파괴 변경 0건. 기준선이 없으면 실패다(건너뛰지 않는다).

바이너리는 ops/bin/contract-check가 GitHub 릴리스에서 받아 해시를 확인하고 $KB_TOOLCHAIN/bin에 둔다.
git을 쓰지 않는다. 비교 대상은 작업 트리의 두 파일이다.
"""
import os
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
CUR = REPO / "docs/contracts/openapi.yaml"
BASE = REPO / "docs/contracts/baseline/openapi.yaml"
VERSION = "1.35.0"


def _bin():
    tc = os.environ.get("KB_TOOLCHAIN") or "/home/user/sagae-kb-data/runtime"
    p = Path(tc) / "bin" / "oasdiff"
    assert p.exists(), f"{p} 없음. ops/bin/contract-check가 설치한다"
    return str(p)


def _run(*args):
    return subprocess.run([_bin(), *args], capture_output=True, text=True, timeout=120)


def test_baseline_exists_and_is_not_empty():
    assert BASE.exists(), "기준선이 없다. 조용히 건너뛰지 않고 실패한다(계약 8장)"
    assert yaml.safe_load(BASE.read_text(encoding="utf-8"))["paths"]


def test_oasdiff_version_is_pinned():
    r = _run("--version")
    assert r.returncode == 0 and VERSION in r.stdout, r.stdout + r.stderr


def test_no_breaking_changes_against_baseline():
    r = _run("breaking", str(BASE), str(CUR), "--fail-on", "ERR")
    assert r.returncode == 0, "파괴 변경:\n" + r.stdout[-2000:] + r.stderr[-500:]


def test_oasdiff_actually_catches_a_breaking_change(tmp_path):
    """검사가 헛돌지 않는다: 경로 하나를 지운 사본은 파괴 변경으로 잡혀야 한다."""
    doc = yaml.safe_load(BASE.read_text(encoding="utf-8"))
    del doc["paths"]["/v1/counts"]
    mutated = tmp_path / "mutated.yaml"
    mutated.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")
    r = _run("breaking", str(BASE), str(mutated), "--fail-on", "ERR")
    assert r.returncode != 0 and "/v1/counts" in r.stdout


def test_missing_baseline_is_a_failure(tmp_path):
    r = _run("breaking", str(tmp_path / "none.yaml"), str(CUR), "--fail-on", "ERR")
    assert r.returncode != 0
