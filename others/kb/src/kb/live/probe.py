"""대상의 신호 수집. 네트워크는 capture(수집 층)를 지나거나, 결정 8 뒤의 gh 호출(ghgraphql.py)만 쓴다.
Fetcher는 URL 하나를 받아 Resp를 돌려준다. 소스 레지스트리가 소유하지 않은 URL은 받지 않는다(None).
OfflineFetcher는 시험과 --dry-run용으로 네트워크를 쓰지 않는다."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import quote

from kb.ingest.rules import repo_name
from kb.live import rules, signals as S
from kb.live.model import Sig


@dataclass
class Resp:
    url: str
    status: int | None
    body: bytes = b""
    final_url: str | None = None
    first_status: int | None = None
    content_type: str | None = None
    snapshot: str | None = None
    source: str | None = None

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    def json(self):
        try:
            return json.loads(self.body)
        except ValueError:
            return {}


class OfflineFetcher:
    """responses: {url: {status, body(str|bytes|dict), final_url?, first_status?, content_type?, snapshot?}}"""

    def __init__(self, responses: dict | None = None):
        self.responses = responses or {}
        self.calls: list = []

    def get(self, url: str) -> Resp | None:
        self.calls.append(url)
        r = self.responses.get(url)
        if r is None:
            return None
        b = r.get("body", b"")
        if isinstance(b, (dict, list)):
            b = json.dumps(b).encode()
        elif isinstance(b, str):
            b = b.encode()
        st = r.get("status", 200)
        return Resp(url, st, b, r.get("final_url") or url, r.get("first_status", st), r.get("content_type"),
                    r.get("snapshot"), r.get("source"))


class CaptureFetcher:
    """레지스트리가 소유한 URL만 capture로 받는다. 소유 소스가 없으면 None."""

    def __init__(self, sources: list | None = None):
        if sources is None:
            from kb.collect import registry
            sources = [s for s in registry.load_registry(validate=False)]
        self.sources = sources
        self.calls: list = []

    def owner(self, url: str):
        from kb.collect import registry
        for s in self.sources:
            if s.enabled and registry.runnable(s)[0] and url in s.all_urls():
                return s
        for s in self.sources:
            if s.enabled and registry.runnable(s)[0] and s.owns_url(url):
                return s
        return None

    def get(self, url: str) -> Resp | None:
        from kb.collect import capture
        from kb.core import cas
        src = self.owner(url)
        if src is None:
            return None
        self.calls.append(url)
        ref = capture(src, url)
        body = b""
        if ref.raw_sha:
            try:
                body = cas.get(ref.raw_sha)
            except (cas.CasError, OSError):
                body = b""
        chain = ref.chain or []
        first = chain[0][1] if chain else ref.status
        final = chain[-1][0] if chain else url
        if not ref.ok and ref.status is None:
            return None
        return Resp(url, ref.status, body, final, first, ref.content_type, ref.snapshot, src.id)


def _title(text: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", text[:20000], re.I | re.S)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()
    m = re.search(r"^\s*#\s+(.+)$", text[:4000], re.M)
    return m.group(1).strip() if m else None


def _tag(sigs, r: Resp | None, out: list) -> None:
    for s in sigs if isinstance(sigs, list) else ([sigs] if sigs else []):
        out.append(s.with_snapshot(r.snapshot if r else None))


@dataclass
class Probe:
    sigs: list = field(default_factory=list)
    requests: int = 0
    missing: list = field(default_factory=list)       # 소스가 없어 못 받은 URL
    chain: list = field(default_factory=list)


def _get(fx, url: str, pr: Probe) -> Resp | None:
    r = fx.get(url)
    if r is None:
        pr.missing.append(url)
    else:
        pr.requests += 1
    return r


def _repo(t: dict, fx, now: int, pr: Probe, gh=None) -> None:
    rn = repo_name(t["props"], t["label"])
    if not rn:
        return
    name = f"{rn[0]}/{rn[1]}"
    docs: dict = {}

    def api(n: str):
        if n in docs:
            return docs[n]
        r = None
        if gh is not None:
            r = gh.repo(n)
            if r is None:              # 이름이 바뀐 저장소는 GraphQL이 옛 이름으로 한 번에 돌려준다
                r = next((x for x in gh.cache.values() if x.ok and str(x.json().get("nameWithOwner", "")).lower() == n.lower()), None)
        if r is None:
            r = _get(fx, f"https://api.github.com/repos/{n}", pr)
        docs[n] = r
        return r

    def step(n: str):
        r = api(n)
        if r is None or not r.ok:
            return None
        fn = r.json().get("full_name") or r.json().get("nameWithOwner")
        return fn if fn and fn.lower() != n.lower() else None

    chain = rules.canonical_chain(name, step)
    pr.chain = chain
    final = chain[-1]
    r = api(final)
    if r is None:
        return
    doc = r.json() if r.ok else {}
    sigs: list = []
    if len(chain) > 1:
        m = S.m02_renamed(doc, name) or S.Sig("M02", "move", None, final, {"canonical": final, "requested": name})
        m = Sig(m.id, m.kind, None, m.quote, {**m.data, "chain": chain, "canonical": final})
        _tag(m, r, sigs)
    _tag([x for x in (S.m03_not_found(r.status), S.m01_archived(doc), S.m04_commit_age(doc, now)) if x], r, sigs)
    rd = _get(fx, f"https://raw.githubusercontent.com/{final}/HEAD/README.md", pr)
    if rd is not None and rd.ok:
        _tag(S.m05_readme(rd.text, final, None), rd, sigs)
    pr.sigs += sigs
    if r.ok and not [s for s in sigs if s.kind != "move"]:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, f"HTTP {r.status}"))


def _package(t: dict, fx, now: int, pr: Probe) -> None:
    from kb.core import config
    p = t["props"]
    name = str(p.get("package") or p.get("name") or t["label"] or "")
    if not name:
        return
    reg = (p.get("registry") or "npm").lower()
    sigs: list = []
    if reg == "pypi":
        if not config.decision_ok(8):
            return                                  # PyPI 신호는 결정 8 뒤
        r = _get(fx, f"https://pypi.org/pypi/{quote(name)}/json", pr)
        if r is None or not r.ok:
            if r is not None:
                _tag(S.m03_not_found(r.status), r, sigs)
                pr.sigs += sigs
            return
        doc = r.json()
        ups = [f.get("upload_time_iso_8601") or f.get("upload_time") for fl in (doc.get("releases") or {}).values() for f in fl]
        last = max([u for u in ups if u], default=None)
        _tag([x for x in (S.m07_pypi_inactive(doc), S.m08_pep792(doc), S.m09_publish_age(last, now)) if x], r, sigs)
    else:
        r = _get(fx, f"https://registry.npmjs.org/{name}", pr)
        if r is None:
            return
        if not r.ok:
            _tag(S.m03_not_found(r.status), r, sigs)
            pr.sigs += sigs
            return
        doc = r.json()
        latest = (doc.get("dist-tags") or {}).get("latest")
        _tag([x for x in (S.m06_npm_deprecated(doc), S.m09_publish_age((doc.get("time") or {}).get(latest), now)) if x], r, sigs)
    pr.sigs += sigs
    if not sigs:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, f"HTTP {r.status}"))


def _document(t: dict, fx, now: int, pr: Probe) -> None:
    p = t["props"]
    url = p.get("url") or (t["label"] if str(t["label"]).startswith("http") else None)
    if not url:
        return
    r = _get(fx, url, pr)
    if r is None:
        return
    sigs: list = []
    _tag([x for x in (S.m10_http_404(r.first_status, r.status), S.m11_redirect(url, r.final_url, r.first_status, r.body),
                      S.m12_tombstone(_title(r.text), r.text)) if x], r, sigs)
    if p.get("llms_txt_url"):
        ll = _get(fx, p["llms_txt_url"], pr)
        if ll is not None and ll.ok:
            _tag(S.m13_llms_txt(ll.text, url), ll, sigs)
    pr.sigs += sigs
    if r.ok and not [s for s in sigs if s.kind != "move"]:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, f"HTTP {r.status}"))


def _feed(t: dict, fx, now: int, pr: Probe) -> None:
    url = t["props"].get("feed_url") or t["props"].get("url")
    if not url:
        return
    r = _get(fx, url, pr)
    if r is None:
        return
    sigs: list = []
    _tag([x for x in (S.m10_http_404(r.first_status, r.status),
                      S.m23_feed_age(r.body, now, r.content_type) if r.ok else None) if x], r, sigs)
    pr.sigs += [s for s in sigs if not (s.id == "M23" and s.kind == "info")]
    if r.ok and not [s for s in sigs if s.kind == "suspect"]:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, f"HTTP {r.status}"))


def _model(t: dict, fx, now: int, pr: Probe) -> None:
    p = t["props"]
    url, mid = p.get("deprecations_url"), p.get("model_id") or p.get("name") or t["label"]
    if not url or not mid:
        return
    r = _get(fx, url, pr)
    if r is None or not r.ok:
        return
    sigs: list = []
    _tag(S.m20_model_table(r.text, mid, now), r, sigs)
    pr.sigs += sigs
    if not [s for s in sigs if s.kind in ("removed", "date")]:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, sigs[0].quote if sigs else f"HTTP {r.status}"))


def _feature(t: dict, fx, now: int, pr: Probe, current: str | None) -> None:
    p = t["props"]
    name = p.get("name") or t["label"]
    sigs: list = []
    alive_r = None
    if p.get("docs_url"):
        r = _get(fx, p["docs_url"], pr)
        if r is not None:
            alive_r = r if r.ok else None
            _tag([x for x in (S.m10_http_404(r.first_status, r.status), S.m12_tombstone(_title(r.text), r.text),
                              S.m14_status_row(r.text, name), S.m15_glossary(r.text, name)) if x], r, sigs)
    if p.get("changelog_url"):
        c = _get(fx, p["changelog_url"], pr)
        if c is not None and c.ok:
            _tag(S.m16_changelog(c.text, name), c, sigs)
            _tag(S.m17_reversal(c.text, name), c, sigs)
    pr.sigs += sigs
    if alive_r is not None and not [s for s in sigs if s.kind not in ("move",)]:
        pr.sigs.append(Sig("M00", "alive", alive_r.snapshot, f"HTTP {alive_r.status}"))


def _mcp(t: dict, fx, now: int, pr: Probe) -> None:
    n = t["props"].get("mcp_name")
    if not n:
        return
    r = _get(fx, t["props"].get("registry_url") or f"https://registry.modelcontextprotocol.io/v0/servers?search={quote(n)}&limit=100", pr)
    if r is None or not r.ok:
        return
    s = S.m21_mcp_registry(r.json(), n)
    if s:
        _tag(s, r, pr.sigs)
    else:
        pr.sigs.append(Sig("M00", "alive", r.snapshot, "registry latest ok"))


def gather(t: dict, fx, now_ms: int, *, gh=None) -> Probe:
    """t: {id, type(단위), label, props, liveness}. 단위별 신호를 모은다."""
    pr = Probe()
    u = t["type"]
    if u == "repo":
        _repo(t, fx, now_ms, pr, gh)
    elif u == "package":
        _mcp(t, fx, now_ms, pr) if t["props"].get("mcp_name") else _package(t, fx, now_ms, pr)
    elif u == "document":
        _document(t, fx, now_ms, pr)
    elif u == "feed":
        _feed(t, fx, now_ms, pr)
    elif u == "model":
        _model(t, fx, now_ms, pr)
    elif u == "feature":
        _feature(t, fx, now_ms, pr, t.get("liveness"))
    return pr
