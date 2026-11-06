"""어댑터가 내는 값과 입력 문맥. 어댑터는 순수 함수이고 이벤트는 events.py가 만든다."""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class Entity:
    id: str
    type: str
    label: str
    props: dict | None = None
    aliases: list | None = None


@dataclass
class Edge:
    src: str
    rtype: str
    dst: str
    props: dict | None = None


@dataclass
class Claim:
    """결정적 주장(method=deterministic, verification=parser_derived). selector는 evidence 한 건의 선택자다."""
    subject: str
    predicate: str
    value: str
    statement: str
    selector: dict
    kind: str = "state"
    unit: str | None = None
    qualifiers: dict | None = None
    valid_from: str | None = None
    precision: str | None = None
    object: str | None = None


@dataclass
class Series:
    slug: str
    label: str
    metric: str
    points: list
    unit: str | None = None
    subject: str | None = None
    granularity: str | None = None


@dataclass
class Result:
    entities: list = field(default_factory=list)
    edges: list = field(default_factory=list)
    claims: list = field(default_factory=list)
    series: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    count: int | None = None        # 구조 가드가 비교하는 항목 수


@dataclass
class Ctx:
    snapshot: dict          # snapshot.captured payload (id, url, source, raw_sha, fetched_at, content_type, domain)
    raw: bytes
    text: object            # kb.parse.display.Text
    source: object | None   # kb.collect.registry.Source
    cfg: dict               # 소스의 parse: 설정

    @property
    def url(self) -> str:
        return self.snapshot["url"]

    @property
    def fetched_at(self) -> int:
        return int(self.snapshot.get("fetched_at") or 0)

    @property
    def day(self) -> str:
        return datetime.fromtimestamp(self.fetched_at / 1000, tz=timezone.utc).strftime("%Y-%m-%d")

    def json(self):
        return json.loads(self.text.text)


def slugify(s: str, maxlen: int = 60) -> str:
    """엔티티·시계열 slug(소문자 영숫자와 '-'). 영숫자가 없는 입력(한글 제목 등)은 해시를 붙여 유일하게 만든다."""
    import hashlib
    src = unicodedata.normalize("NFKC", s).lower()
    base = re.sub(r"[^a-z0-9]+", "-", src).strip("-")
    if not base:
        return "x-" + hashlib.sha256(src.encode()).hexdigest()[:12]
    if len(base) > maxlen:
        base = base[:maxlen - 11].strip("-") + "-" + hashlib.sha256(src.encode()).hexdigest()[:10]
    return base


def day_ms(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def quote(text: str, exact: str, start: int = 0, ctx: int = 24) -> dict | None:
    """표시 본문에서 exact를 찾아 text_quote 선택자를 만든다. 없으면 None(근거 없는 주장은 내지 않는다)."""
    i = text.find(exact, max(0, start))
    if i < 0 or not exact:
        return None
    j = i + len(exact)
    return {"selector_kind": "text_quote", "exact": exact, "start_cp": i, "end_cp": j,
            "prefix": text[max(0, i - ctx):i], "suffix": text[j:j + ctx]}


def pointer(ptr: str, value) -> dict:
    return {"selector_kind": "jsonpointer", "json_pointer": ptr, "exact": json.dumps(value, ensure_ascii=False)}


def ptr_escape(k: str) -> str:
    return str(k).replace("~", "~0").replace("/", "~1")
