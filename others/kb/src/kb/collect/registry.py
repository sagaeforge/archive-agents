"""소스 레지스트리(ADR 10.4). sources/domains/*.yaml을 읽고 sources/overlays/*.yaml을 덮어 읽는다.
이 모듈은 구조와 정책 규칙만 검사한다. 소스 목록은 WP-07이 채운다."""
from __future__ import annotations

import copy
import functools
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from kb.collect.errors import RegistryError
from kb.core import config, paths

ADHOC_ID = "src:adhoc"
TOS_RANK = {"allowed": 0, "no_clause": 1, "unverified": 2, "signals_conflict": 3, "forbidden": 4}
ROBOTS_MODES = ("enforce", "official_api")
DISCOVER_KINDS = ("llms_txt", "sitemap", "html_index")
POLICY_DEFAULTS = {"enabled": True, "tos": "unverified", "tos_ref": None, "robots": "enforce", "requires_decision": None,
                   "trust": "unknown", "retention": "permanent", "pii": False, "needs_contact": False}
DEFAULT_MAX_PAGES_PER_TICK = 50
DEFAULT_MAX_DEPTH = 2


def sources_dir() -> Path:
    return paths.share_dir() / "sources"


def _yaml():
    import yaml  # collect 추가 의존성. 없으면 레지스트리를 읽을 수 없다
    return yaml


def read_yaml(p: Path):
    with open(p, "rb") as f:
        return _yaml().safe_load(f)


def host_of(url: str) -> str | None:
    try:
        return (urlsplit(url).hostname or "").lower() or None
    except ValueError:
        return None


@dataclass
class Source:
    id: str
    raw: dict
    name: str = ""
    inventory_id: str | None = None
    domain: list = field(default_factory=list)
    class_: str | None = None
    fetch: dict = field(default_factory=dict)
    parser: str | None = None
    expect: dict = field(default_factory=dict)
    fallbacks: list = field(default_factory=list)
    policy: dict = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return bool(self.policy.get("enabled"))

    @property
    def needs_contact(self) -> bool:
        return bool(self.policy.get("needs_contact"))

    @property
    def tos(self) -> str:
        return self.policy.get("tos", "unverified")

    @property
    def index_url(self) -> str | None:
        return self.fetch.get("url")

    @property
    def discover(self) -> dict | None:
        return self.fetch.get("discover")

    def static_urls(self) -> list[tuple[str, int | None]]:
        """urls 목록: (url, URL 단위 requires_decision)."""
        out = []
        for it in self.fetch.get("urls") or []:
            if isinstance(it, str):
                out.append((it, None))
            else:
                out.append((it["url"], it.get("requires_decision")))
        return out

    def all_urls(self) -> list[str]:
        u = []
        if self.index_url:
            u.append(self.index_url)
        u += [x for x, _ in self.static_urls()]
        return u

    def hosts(self) -> set[str]:
        return {h for h in (host_of(u) for u in self.all_urls()) if h}

    def url_decision(self, url: str) -> int | None:
        for u, d in self.static_urls():
            if u == url:
                return d
        return None

    def owns_url(self, url: str) -> bool:
        if url in self.all_urls():
            return True
        h = host_of(url)
        return bool(h and h in self.hosts() and self.discover)


def adhoc_source() -> Source:
    """등록되지 않은 URL의 소스. tos=unverified, trust=unknown."""
    pol = dict(POLICY_DEFAULTS, tos="unverified", trust="unknown", retention="ttl")
    return Source(id=ADHOC_ID, raw={"id": ADHOC_ID}, name="ad hoc", class_=None, policy=pol)


def _deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _entries(doc) -> list[dict]:
    if doc is None:
        return []
    if isinstance(doc, list):
        return [d for d in doc if isinstance(d, dict)]
    if isinstance(doc, dict):
        if "sources" in doc:
            return [d for d in doc["sources"] or [] if isinstance(d, dict)]
        if "id" in doc:
            return [doc]
    return []


@functools.lru_cache(maxsize=1)
def _classes_cached(p: str, mtime: float) -> dict:
    return read_yaml(Path(p)) or {}


def load_classes() -> dict:
    p = sources_dir() / "classes.yaml"
    if not p.exists():
        return {"jitter": 0.1, "classes": {}}
    return _classes_cached(str(p), p.stat().st_mtime)


def _build(raw: dict) -> Source:
    pol = dict(POLICY_DEFAULTS)
    pol.update(raw.get("policy") or {})
    fetch = dict(raw.get("fetch") or {})
    return Source(id=raw["id"], raw=raw, name=raw.get("name", ""), inventory_id=raw.get("inventory_id"),
                  domain=list(raw.get("domain") or []), class_=raw.get("class"), fetch=fetch, parser=raw.get("parser"),
                  expect=dict(raw.get("expect") or {}), fallbacks=list(raw.get("fallbacks") or []), policy=pol)


def read_overlays(root: Path | None = None) -> tuple[dict[str, dict], set[str]]:
    """(소스 id -> 덮을 부분 항목, host_allow 집합)."""
    root = root or sources_dir()
    patches: dict[str, dict] = {}
    allow: set[str] = set()
    d = root / "overlays"
    if not d.is_dir():
        return patches, allow
    for p in sorted(d.glob("*.yaml")):
        doc = read_yaml(p)
        if isinstance(doc, dict):
            for h in doc.get("host_allow") or []:
                allow.add(str(h).lower())
        for e in _entries(doc):
            patches[e["id"]] = _deep_merge(patches.get(e["id"], {}), e)
    return patches, allow


def host_allow() -> set[str]:
    return read_overlays()[1]


def load_registry(root: Path | None = None, *, validate: bool = True) -> list[Source]:
    root = root or sources_dir()
    raws: dict[str, dict] = {}
    d = root / "domains"
    if d.is_dir():
        for p in sorted(d.glob("*.yaml")):
            for e in _entries(read_yaml(p)):
                if e["id"] in raws:
                    raise RegistryError(f"소스 id 중복: {e['id']} ({p.name})")
                raws[e["id"]] = e
    patches, _ = read_overlays(root)
    for sid, patch in patches.items():
        if sid in raws:
            raws[sid] = _deep_merge(raws[sid], patch)
        # 도메인 파일에 없는 overlay 항목은 소스가 아니다(host_allow만 가진 항목 포함)
    srcs = [_build(r) for r in raws.values()]
    if validate:
        validate_registry(srcs)
    return srcs


def get_source(source_id: str) -> Source | None:
    if source_id == ADHOC_ID:
        return adhoc_source()
    for s in load_registry():
        if s.id == source_id:
            return s
    return None


def validate_registry(srcs: list[Source]) -> None:
    by_id = {s.id: s for s in srcs}
    classes = (load_classes().get("classes") or {})
    for s in srcs:
        pol = s.policy
        if not re.fullmatch(r"src:[a-z0-9]+(?:[._-][a-z0-9]+)*", s.id):
            raise RegistryError(f"{s.id}: 소스 id 형식 위반")
        if pol["tos"] not in TOS_RANK:
            raise RegistryError(f"{s.id}: policy.tos 값 오류: {pol['tos']!r}")
        if pol["robots"] not in ROBOTS_MODES:
            raise RegistryError(f"{s.id}: policy.robots 값 오류: {pol['robots']!r}")
        if pol["robots"] == "official_api" and not pol.get("tos_ref"):
            raise RegistryError(f"{s.id}: robots=official_api는 tos_ref가 필수다")
        if s.enabled:
            if not s.class_ or (classes and s.class_ not in classes):
                raise RegistryError(f"{s.id}: 활성 소스는 클래스가 필수다(class={s.class_!r})")
            if pol["tos"] == "forbidden":
                raise RegistryError(f"{s.id}: tos=forbidden 소스는 비활성이어야 한다")
            if not s.all_urls():
                raise RegistryError(f"{s.id}: fetch에 url 또는 urls가 없다")
        disc = s.discover
        if disc is not None:
            if not s.index_url:
                raise RegistryError(f"{s.id}: discover에는 fetch.url(색인)이 필수다")
            if disc.get("kind") not in DISCOVER_KINDS:
                raise RegistryError(f"{s.id}: discover.kind 값 오류: {disc.get('kind')!r}")
            if not isinstance(disc.get("max_pages"), int) or disc["max_pages"] < 1:
                raise RegistryError(f"{s.id}: discover.max_pages는 필수 정수다")
        for u in s.all_urls():
            if not host_of(u):
                raise RegistryError(f"{s.id}: URL 형식 오류: {u!r}")
        for fb in s.fallbacks:
            f = by_id.get(fb)
            if f is not None and TOS_RANK[f.tos] > TOS_RANK[pol["tos"]]:
                raise RegistryError(f"{s.id}: 대체 소스 {fb}가 tos 등급을 올린다({pol['tos']} -> {f.tos})")


def runnable(s: Source) -> tuple[bool, str | None]:
    """수집 코드가 이 소스를 호출해도 되는가. 아니면 (False, 이유). 네트워크 호출 전에 확인한다."""
    pol = s.policy
    if not s.enabled:
        return False, "disabled"
    rd = pol.get("requires_decision")
    if rd is not None and not config.decision_ok(int(rd)):
        return False, f"decision_{rd}_pending"
    if pol["robots"] == "official_api":
        if not pol.get("tos_ref"):
            return False, "config_error:official_api_without_tos_ref"
        if not config.decision_ok(8):
            return False, "decision_8_pending"
    if s.needs_contact and not contact_text():
        return False, "contact_missing"
    return True, None


def contact_text() -> str | None:
    p = paths.config_dir() / "contact"
    try:
        t = p.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return t or None
