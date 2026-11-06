"""앵커 {seq, head_hash, at}: 원장 머리를 ledger/anchors.ndjson에 쌓는다(ADR 17.2).

낡은 백업은 체인 검증을 통과하므로 머신 밖에 남은 앵커만 꼬리 유실을 드러낸다.
앵커는 평문 비밀이 없는 해시라 핑 본문과 내보내기 git 커밋에 넣어도 된다.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from kb.core import cas, ledger, paths
from kb.core.canon import canon_json


def anchors_path() -> Path:
    return paths.ledger_dir() / "anchors.ndjson"


def read_anchors(path: str | Path | None = None) -> list[dict]:
    """깨진 줄과 개행 없는 꼬리는 건너뛴다. 앵커는 보조 증거라 읽기가 죽으면 안 된다."""
    p = Path(path) if path else anchors_path()
    if not p.exists():
        return []
    raw = p.read_bytes()
    out = []
    for line in raw[:raw.rfind(b"\n") + 1].splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if isinstance(d, dict) and isinstance(d.get("seq"), int) and isinstance(d.get("head_hash"), str):
            out.append(d)
    return out


def append_anchor(led, *, now_ms: int | None = None) -> dict | None:
    """현재 머리를 덧붙인다. 마지막 앵커와 같은 머리면 쓰지 않는다(None). 원장이 비었으면 쓰지 않는다."""
    seq, h = ledger.head(led)
    if seq == 0:
        return None
    prev = read_anchors()
    if prev and prev[-1]["seq"] == seq and prev[-1]["head_hash"] == h:
        return None
    row = {"seq": seq, "head_hash": h, "at": int(time.time() * 1000) if now_ms is None else now_ms}
    p = anchors_path()
    cas.make_dirs(p.parent)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        cas.write_all(fd, canon_json(row) + b"\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    cas.fsync_dir(p.parent)
    return row


def latest(anchors: list[dict] | None = None) -> dict | None:
    a = read_anchors() if anchors is None else anchors
    return max(a, key=lambda x: x["seq"]) if a else None


def ping_body(anchor: dict | None = None) -> str:
    """healthchecks 핑 본문. 앵커가 없으면 빈 문자열."""
    a = anchor or latest()
    return canon_json({"seq": a["seq"], "head_hash": a["head_hash"], "at": a["at"]}).decode() if a else ""


def check(led, anchors: list[dict] | None = None) -> dict:
    """원장을 앵커와 대조한다.

    - mismatch: 앵커 seq가 원장 안에 있는데 해시가 다르다(분기, 변조, 다른 원장).
    - behind: 가장 새 앵커가 원장 머리보다 앞서 있다. 그 사이가 유실 범위다.
    """
    a = read_anchors() if anchors is None else anchors
    seq, h = ledger.head(led)
    mism = []
    for x in a:
        if x["seq"] <= seq:
            r = led.execute("SELECT hash FROM event WHERE seq=?", (x["seq"],)).fetchone()
            if r is None or r[0] != x["head_hash"]:
                mism.append({"seq": x["seq"], "anchor_hash": x["head_hash"], "ledger_hash": r[0] if r else None})
    top = latest(a)
    behind = top is not None and top["seq"] > seq
    lost = {"from_seq": seq + 1, "to_seq": top["seq"], "count": top["seq"] - seq} if behind else None
    return {"ok": not mism and not behind, "anchors": len(a), "head_seq": seq, "head_hash": h,
            "anchor_seq": top["seq"] if top else None, "mismatch": mism, "behind": behind, "lost": lost}
