"""식별자 규칙(ADR 7.5). 모든 공개 ID는 check_public_id 패턴을 따른다."""
from __future__ import annotations

import base64
import hashlib
import os
import re
import threading
import time
import unicodedata
import uuid
from urllib.parse import urlsplit, urlunsplit

from kb.core.canon import canon_json, sha256_hex

PUBLIC_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._-]*")
SLUG_RE = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*")
TYPE_RE = re.compile(r"[a-z][a-z0-9_]*")
MAX_ID_LEN = 256


def check_public_id(s: str) -> str:
    """공개 ID 불변식. 위반이면 ValueError. 통과하면 그대로 돌려준다."""
    if not isinstance(s, str) or not s or len(s) > MAX_ID_LEN or not PUBLIC_ID_RE.fullmatch(s):
        raise ValueError(f"공개 ID 형식 위반: {s!r}")
    return s


def _b32(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").lower().rstrip("=")


def _b2(parts: list, n: int = 12) -> str:
    h = hashlib.blake2b(canon_json(parts), digest_size=16).digest()
    return _b32(h)[:n]


def norm_text(s: str) -> str:
    """주장 ID 입력용 인용구 정규화: NFC, 공백 압축, 앞뒤 공백 제거."""
    return " ".join(unicodedata.normalize("NFC", s).split())


def normalize_url(url: str) -> str:
    """ID 입력용 URL 정규화. 스킴·호스트 소문자, 기본 포트·프래그먼트 제거, 빈 경로는 /."""
    u = urlsplit(url.strip())
    scheme = u.scheme.lower()
    host = (u.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    port = u.port
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    netloc = host
    if u.username is not None:
        raise ValueError("userinfo가 있는 URL은 ID로 쓰지 않음")
    return urlunsplit((scheme, netloc, u.path or "/", u.query, ""))


def claim_id_llm(subject: str, quote: str) -> str:
    return "c-" + _b2([subject, norm_text(quote)])


def claim_id_det(subject: str, predicate: str, qualifiers: dict | None = None,
                 value: str | None = None, period: str | dict | None = None) -> str:
    return "c-" + _b2([subject, predicate, qualifiers or {}, value, period])


def snapshot_id(raw_sha: str, url: str) -> str:
    return "n-" + sha256_hex(canon_json([raw_sha, normalize_url(url)]))[:16]


def document_id(url: str) -> str:
    return "d-" + sha256_hex(normalize_url(url))[:16]


def edge_id(src: str, rtype: str, dst: str, qualifiers: dict | None = None) -> str:
    return "r-" + _b2([src, rtype, dst, qualifiers or {}])


def evidence_id(claim_id: str, snapshot_id_: str, selector: str | dict) -> str:
    return "ev-" + _b2([claim_id, snapshot_id_, selector])


def entity_id(type_: str, slug: str) -> str:
    t = (type_ or "").lower()
    if not TYPE_RE.fullmatch(t):
        raise ValueError(f"엔티티 type 형식 위반: {type_!r}")
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(f"엔티티 slug 형식 위반: {slug!r}")
    return check_public_id(f"e:{t}:{slug}")


def series_id(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(f"series slug 형식 위반: {slug!r}")
    return f"s:{slug}"


def source_id(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(f"source slug 형식 위반: {slug!r}")
    return f"src:{slug}"


_mu = threading.Lock()
_last = [0, 0]  # ms, 12비트 카운터


def uuid7() -> str:
    """UUIDv7 문자열. 한 프로세스 안에서 단조 증가한다."""
    with _mu:
        ms = int(time.time() * 1000)
        if ms <= _last[0]:
            ms = _last[0]
            _last[1] += 1
            if _last[1] > 0xFFF:
                ms += 1
                _last[1] = 0
        else:
            _last[1] = int.from_bytes(os.urandom(2), "big") & 0x3FF
        _last[0] = ms
        rand_a = _last[1]
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    n = (ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=n))


def uuid7_b32(u: str | None = None) -> str:
    return _b32(uuid.UUID(u or uuid7()).bytes)


def record_id() -> str:
    return "f-" + uuid7_b32()


def ticket_id() -> str:
    return "t-" + uuid7_b32()
