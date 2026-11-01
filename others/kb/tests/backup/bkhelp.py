"""WP-13 시험 도우미: 임시 restic 저장소, 가짜 findmnt, 실패 주입 래퍼, 평문 탐색."""
from __future__ import annotations

import json
import os
import shutil
import stat
import sys
from pathlib import Path

import yaml
from compression import zstd

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests" / "write"))
sys.path.insert(0, str(REPO / "tests" / "project"))

PW = "pw-test-only"


def find_restic() -> str | None:
    for c in (os.environ.get("KB_RESTIC_BIN"), os.environ.get("KB_TOOLCHAIN", "") + "/bin/restic",
              "/home/user/sagae-kb-data/runtime/bin/restic", shutil.which("restic")):
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return c
    return None


_TPL: Path | None = None


def template_repo(restic: str) -> Path:
    global _TPL
    if _TPL is None or not _TPL.exists():
        import subprocess
        root = Path(os.environ.get("KB_BUILD_ROOT") or Path.home() / ".cache/sagae-kb/build")
        _TPL = root / f"restic-template-{os.getpid()}"
        shutil.rmtree(_TPL, ignore_errors=True)
        env = {**{k: v for k, v in os.environ.items() if not k.startswith("RESTIC_")},
               "RESTIC_REPOSITORY": str(_TPL), "RESTIC_PASSWORD": PW}
        subprocess.run([restic, "init", "-q"], env=env, check=True, capture_output=True)
    return _TPL


def drop_template() -> None:
    if _TPL is not None:
        shutil.rmtree(_TPL, ignore_errors=True)


class Env:
    def __init__(self, home: Path, restic: str):
        self.home = home
        self.cfg = home / "config"
        self.restic = restic
        self.bin = home / "fakebin"
        self.bin.mkdir(exist_ok=True)
        self.cfg.mkdir(exist_ok=True)
        self.mnt_json = home / "findmnt.json"
        self.log = home / "restic.log"
        self.specs: list[dict] = []

    # ---- 가짜 findmnt
    def fake_findmnt(self) -> str:
        p = self.bin / "findmnt"
        p.write_text('#!/bin/sh\n[ -n "$FAKE_FINDMNT_RC" ] && exit "$FAKE_FINDMNT_RC"\ncat "$FAKE_FINDMNT_JSON"\n')
        p.chmod(0o755)
        return str(p)

    def set_mount(self, path: str, *, source="E:\\", fstype="9p", options=None, target=None) -> None:
        if options is None:
            options = r"rw,noatime,aname=drvfs;path=E:\;uid=1000;gid=1000;metadata;symlinkroot=/mnt/"
        self.mnt_json.write_text(json.dumps({"filesystems": [{"target": target or path, "source": source,
                                                              "fstype": fstype, "options": options}]}))

    def set_not_mounted(self) -> None:
        """마운트가 빠진 /mnt/e: findmnt -T는 바깥 ext4 마운트를 돌려준다."""
        self.mnt_json.write_text(json.dumps({"filesystems": [{"target": "/", "source": "/dev/sdc",
                                                              "fstype": "ext4", "options": "rw,relatime"}]}))

    # ---- restic 래퍼(실패 주입, 호출 기록)
    def wrapper(self) -> str:
        p = self.bin / "restic-wrap"
        p.write_text(f'''#!/bin/sh
echo "$RESTIC_REPOSITORY $*" >> "{self.log}"
if [ -n "$KB_FAIL_REPO" ] && [ "$RESTIC_REPOSITORY" = "$KB_FAIL_REPO" ]; then
  case "$1" in backup|copy) echo "error: read: input/output error" >&2; exit 1;; esac
fi
exec "{self.restic}" "$@"
''')
        p.chmod(0o755)
        return str(p)

    def init(self) -> None:
        """restic init은 KDF 때문에 3초쯤 걸린다. 한 번 만든 빈 저장소를 복사해 쓴다."""
        from kb.guard import ship
        tpl = template_repo(self.restic)
        for t in ship.load_targets():
            if t.mount:  # init_repo의 마운트 1단계 확인은 그대로 거친다
                probe = ship.Target(t.id, t.kind, t.repo, t.tiers, {k: v for k, v in t.mount.items() if k != "marker"})
                assert ship.check_mount(probe).ok
            shutil.copytree(tpl, t.repo)
            mk = (t.mount or {}).get("marker")
            if mk:
                (Path(t.repo) / mk).write_text(t.id + "\n")

    def snapshots(self, tid: str, *tags: str) -> list[dict]:
        from kb.guard import ship
        t = next(x for x in ship.load_targets() if x.id == tid)
        args = ["snapshots", "--json"]
        for g in tags:
            args += ["--tag", g]
        return json.loads(ship.run_restic(t, args, ship.load_secrets()).stdout or "[]")

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    # ---- 설정 파일
    def write_config(self, specs: list[dict]) -> None:
        self.specs = specs
        (self.cfg / "targets.yaml").write_text(yaml.safe_dump({"targets": specs}, allow_unicode=True))
        s = self.cfg / "secrets.env"
        s.write_text(f"RESTIC_PASSWORD={PW}\n")
        s.chmod(0o600)


def local_spec(home: Path, tid="local-c", **kw) -> dict:
    return {"id": tid, "kind": "local", "repo": str(home / "repos" / tid), **kw}


def offsite_spec(home: Path, tid="offsite-e", sub="fake-e") -> dict:
    mp = home / sub
    return {"id": tid, "kind": "external_drive", "repo": str(mp / "kb-restic"),
            "mount": {"path": str(mp), "fstype": "drvfs", "options_require": ["metadata"],
                      "marker": ".kb-offsite-id"}}


def rerun_json(path: Path) -> dict:
    return json.loads(path.read_text())


# ---- 평문 탐색: sqlite, zstd(세그먼트, 스트림), CAS(zstd + 꼬리표)
def _variants(data: bytes):
    yield data
    for d in (data, data[:-32]):
        try:
            out = zstd.decompress(d)
        except Exception:  # noqa: BLE001
            continue
        yield out


def file_has(path: Path, needle: bytes) -> bool:
    try:
        data = path.read_bytes()
    except OSError:
        return False
    return any(needle in v for v in _variants(data))


def tree_has(root: Path, needle: bytes) -> list[str]:
    hits = []
    for dp, _d, fns in os.walk(root):
        for fn in fns:
            p = Path(dp) / fn
            if p.is_symlink() or not p.is_file():
                continue
            if file_has(p, needle):
                hits.append(str(p))
    return hits


# ---- 자료 만들기
def open_fp() -> None:
    from wrhelp import open_fp_direct
    open_fp_direct()


def put(title, body, sens="internal", key=None, **kw):
    from kb.write import put_record
    return put_record({"type": "Note", "title": title, "body": body, "sensitivity": sens, **kw},
                      key or f"bk-{title}", "mcp", "s-a")


def project() -> None:
    from kb.write.engine import project_pending
    project_pending()


def held_item(name="held-1", rid="f-held1", body="보류 본문입니다"):
    from kb.core import spool
    from kb.write import engine
    evs = [{"kind": "record.put", "actor": "agent:s-a", "origin": "first_party", "subject": rid, "idem_key": name,
            "payload": {"id": rid, "type": "Note", "title": "보류", "body": body, "sensitivity": "internal"}}]
    return spool.put("fp-held", engine._queued(evs), engine.hold_name(evs))


def inbox_files(home: Path) -> list[Path]:
    d = home / "inbox"
    (d / ".done" / "2026-11-01").mkdir(parents=True, exist_ok=True)
    a = d / "pending.md"
    a.write_text("---\nid: f-inb1\ntype: Note\ntitle: 대기\n---\n\n대기 본문\n")
    b = d / ".done" / "2026-11-01" / "done1.md"
    b.write_text("---\nid: f-inb2\ntype: Note\ntitle: 끝\n---\n\n끝난 본문\n")
    return [a, b]


def wipe(home: Path) -> None:
    for n in ("ledger", "raw", "spool", "inbox", "ship", "derived", "export"):
        shutil.rmtree(home / n, ignore_errors=True)
