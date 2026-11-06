"""차단 목록 $KB_CONFIG_DIR/intake-deny.txt (0600, 저장소 밖). 이름은 출력, 로그, 반환값 어디에도 남기지 않는다."""
from __future__ import annotations

import os
import re
import socket
import sys
from pathlib import Path

from kb.core import paths
from kb.intake.errors import IntakeError
from kb.intake.scrub import INTERNAL_HOST

MIN_LEN = 3
_SKIP_HOSTS = re.compile(r"^(localhost(\..*)?|ip6-.*|broadcasthost|.*\.localdomain)$", re.I)
_IPLIKE = re.compile(r"^[0-9.:a-fA-F]+$")


def deny_path() -> Path:
    return paths.config_dir() / "intake-deny.txt"


def load() -> list[str]:
    """없거나 비면 E_DENY_MISSING."""
    p = deny_path()
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        raise IntakeError("E_DENY_MISSING", "차단 목록이 없다. kb intake deny-build를 먼저 돈다") from None
    names = [ln.strip() for ln in raw.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    names = [n for n in names if len(n) >= MIN_LEN]
    if not names:
        raise IntakeError("E_DENY_MISSING", "차단 목록이 비어 있다. kb intake deny-build를 먼저 돈다")
    return names


def hosts_file_names(path: str = "/etc/hosts") -> set[str]:
    out: set[str] = set()
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for ln in lines:
        ln = ln.split("#", 1)[0].split()
        for name in ln[1:]:
            if _SKIP_HOSTS.match(name) or _IPLIKE.match(name):
                continue
            out.add(name)
    return out


def copy_hosts(copy_dir: Path) -> set[str]:
    """접수 사본에서 찾은 .local .lan .internal .home.arpa 호스트."""
    out: set[str] = set()
    if not copy_dir.is_dir():
        return out
    for f in sorted(copy_dir.rglob("*")):
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in INTERNAL_HOST.finditer(text):
            out.add(m.group(0))
    return out


def read_names(spec: str | None) -> set[str]:
    """spec: 파일 경로 또는 -(표준입력). 한 줄에 이름 하나."""
    if not spec:
        return set()
    text = sys.stdin.read() if spec == "-" else Path(spec).read_text(encoding="utf-8")
    return {ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")}


def build(copy_dir: Path, node_names: set[str]) -> dict:
    """차단 목록을 만든다(멱등: 있는 항목은 유지하고 합친다). 건수만 돌려준다."""
    p = deny_path()
    old: set[str] = set()
    if p.exists():
        old = {ln.strip() for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()}
    host = {socket.gethostname()}
    hosts = hosts_file_names()
    chost = copy_hosts(copy_dir)
    new = {n for n in (host | hosts | node_names | chost) if len(n) >= MIN_LEN}
    allv = sorted(old | new)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".tmp{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(allv) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)
    return {"entries": len(allv), "added": len(set(allv) - old),
            "sources": {"hostname": len(host), "hosts_file": len(hosts), "nodes": len(node_names),
                        "copy_hosts": len(chost)}}
