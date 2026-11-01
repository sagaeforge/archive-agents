"""쓰기 시 비밀 탐지. Gitleaks v8.30.1 기본 규칙(schemas/secrets/gitleaks.toml, MIT)을 Python re로 읽는다.

판정은 Gitleaks와 같게 한다.
- keywords로 미리 거른다(소문자 부분 문자열).
- 비밀값은 secretGroup, 없으면 첫 캡처 그룹, 없으면 전체 일치다.
- entropy가 있는 규칙은 비밀값의 Shannon 엔트로피(비트/문자)가 그 값 이상일 때만 적중이다.
- 전역 allowlist(regexes, stopwords, paths)와 규칙별 allowlist를 regexTarget(secret|match|line) 대로 적용한다.
- 정규식이 없는 경로 규칙 pkcs12-file은 뺀다. path 조건이 있는 규칙은 파일 이름(source_path)이 있을 때만,
  경로까지 맞춰 적용한다.
Python re와 다른 표기는 로더가 고친다: 인라인 전역 플래그를 패턴 앞으로 옮기고, POSIX 클래스
[[:alnum:]]를 [0-9A-Za-z]로 바꾼다. 컴파일 경고는 오류로 본다.

여기에 두 규칙을 더한다: 개인 키 머리, 고엔트로피 값이 든 KEY=값 줄(.env 형식).
DISABLE_AUTOUPDATER=1처럼 값이 짧거나 평문인 줄은 잡지 않는다.
적중 결과에는 규칙 ID만 담고 비밀값은 담지 않는다.
"""
from __future__ import annotations

import math
import re
import tomllib
import warnings
from collections import Counter
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable

from kb.core import paths

_FLAG = re.compile(r"\(\?([aiLmsux]+)\)")
KEYS_DROPPED = frozenset({"pkcs12-file"})
EXTRA_PRIVATE_KEY = "kb-private-key-header"
EXTRA_ENV_LINE = "kb-env-high-entropy"
_PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
_ENV_LINE = re.compile(r"(?m)^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,63})[ \t]*=[ \t]*[\"']?([^\s\"'#]{20,})[\"']?")
ENV_MIN_ENTROPY = 3.5


class RuleLoadError(Exception):
    pass


def entropy(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in Counter(s).values())


def fix_regex(rx: str) -> str:
    """Go(RE2) 표기를 Python re로. 인라인 전역 플래그는 앞으로 옮긴다."""
    rx = rx.replace("[[:alnum:]]", "[0-9A-Za-z]")
    flags = "".join(dict.fromkeys("".join(_FLAG.findall(rx))))
    if not flags:
        return rx
    return f"(?{flags})" + _FLAG.sub("", rx)


def _compile(rx: str, what: str) -> re.Pattern:
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # re는 모르는 표기를 경고만 내고 다른 뜻으로 읽는다
        try:
            return re.compile(fix_regex(rx))
        except (re.error, Warning) as e:
            raise RuleLoadError(f"{what}: {e}") from e


@dataclass
class Allow:
    regexes: list[re.Pattern] = field(default_factory=list)
    stopwords: list[str] = field(default_factory=list)
    paths: list[re.Pattern] = field(default_factory=list)
    target: str = "secret"
    all_of: bool = False

    def allows(self, secret: str, match: str, line: str, path: str | None) -> bool:
        res: list[bool] = []
        if self.regexes:
            t = {"secret": secret, "match": match, "line": line}[self.target]
            res.append(any(r.search(t) for r in self.regexes))
        if self.stopwords:
            low = secret.lower()
            res.append(any(w.lower() in low for w in self.stopwords))
        if self.paths:
            res.append(path is not None and any(r.search(path) for r in self.paths))
        if not res:
            return False
        return all(res) if self.all_of else any(res)


def _allow(d: dict, what: str) -> Allow:
    tgt = d.get("regexTarget", "secret")
    if tgt not in ("secret", "match", "line"):
        raise RuleLoadError(f"{what}: regexTarget {tgt!r}")
    return Allow([_compile(x, what) for x in d.get("regexes", [])], list(d.get("stopwords", [])),
                 [_compile(x, what) for x in d.get("paths", [])], tgt, d.get("condition", "OR").upper() == "AND")


@dataclass
class Rule:
    id: str
    regex: re.Pattern
    keywords: tuple[str, ...]
    entropy: float | None
    group: int | None
    path: re.Pattern | None
    allows: list[Allow]


@dataclass(frozen=True)
class Hit:
    rule: str
    start: int
    end: int


@dataclass
class RuleSet:
    rules: list[Rule]
    allow: Allow
    skipped: list[str]
    version: str = "v8.30.1"


def rules_path():
    return paths.share_dir() / "schemas" / "secrets" / "gitleaks.toml"


@lru_cache(maxsize=4)
def _load(path_s: str) -> RuleSet:
    with open(path_s, "rb") as f:
        cfg = tomllib.load(f)
    rules: list[Rule] = []
    skipped: list[str] = []
    for r in cfg["rules"]:
        rid = r["id"]
        if rid in KEYS_DROPPED or "regex" not in r:
            skipped.append(rid)
            continue
        rules.append(Rule(rid, _compile(r["regex"], rid), tuple(k.lower() for k in r.get("keywords", [])),
                          r.get("entropy"), r.get("secretGroup"),
                          _compile(r["path"], rid) if r.get("path") else None,
                          [_allow(a, rid) for a in r.get("allowlists", [])]))
    return RuleSet(rules, _allow(cfg.get("allowlist", {}), "global"), skipped)


def load_rules(path=None) -> RuleSet:
    return _load(str(path or rules_path()))


def _line_of(text: str, a: int, b: int) -> str:
    s = text.rfind("\n", 0, a) + 1
    e = text.find("\n", b)
    return text[s:] if e < 0 else text[s:e]


def _secret_of(rule: Rule, m: re.Match) -> str:
    if rule.group is not None:
        return m.group(rule.group) or ""
    if m.re.groups >= 1:
        for i in range(1, m.re.groups + 1):
            if m.group(i):
                return m.group(i)
        return m.group(0)
    return m.group(0)


def scan_text(text: str, source_path: str | None = None, rs: RuleSet | None = None) -> list[Hit]:
    """text에서 비밀 후보를 찾는다. 같은 규칙 ID가 여러 번 맞아도 구간마다 낸다."""
    if not text:
        return []
    rs = rs or load_rules()
    if source_path and any(r.search(source_path) for r in rs.allow.paths):
        return []
    low = text.lower()
    hits: list[Hit] = []
    for rule in rs.rules:
        if rule.path is not None and (source_path is None or not rule.path.search(source_path)):
            continue
        if rule.keywords and not any(k in low for k in rule.keywords):
            continue
        for m in rule.regex.finditer(text):
            secret = _secret_of(rule, m)
            if not secret:
                continue
            if rule.entropy is not None and entropy(secret) < rule.entropy:
                continue
            line = _line_of(text, m.start(), m.end())
            if rs.allow.allows(secret, m.group(0), line, source_path):
                continue
            if any(a.allows(secret, m.group(0), line, source_path) for a in rule.allows):
                continue
            hits.append(Hit(rule.id, m.start(), m.end()))
    for m in _PRIVATE_KEY.finditer(text):
        hits.append(Hit(EXTRA_PRIVATE_KEY, m.start(), m.end()))
    for m in _ENV_LINE.finditer(text):
        val = m.group(2)
        if re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", val) and "@" not in val:
            continue
        if not (re.search(r"[A-Za-z]", val) and re.search(r"\d", val)):
            continue
        if entropy(val) < ENV_MIN_ENTROPY:
            continue
        line = _line_of(text, m.start(), m.end())
        if rs.allow.allows(val, m.group(0), line, source_path):
            continue
        hits.append(Hit(EXTRA_ENV_LINE, m.start(), m.end()))
    return hits


def iter_strings(obj: Any, prefix: str = "") -> Iterable[tuple[str, str]]:
    """JSON 값 안의 모든 문자열(값과 키)을 (경로, 문자열)로 낸다."""
    if isinstance(obj, str):
        yield prefix, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield prefix + "/<key>", str(k)
            yield from iter_strings(v, f"{prefix}/{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from iter_strings(v, f"{prefix}/{i}")


def scan_record(record: dict) -> list[str]:
    """레코드의 제목, 본문, props, 링크의 전 문자열 필드를 검사한다. 적중한 규칙 ID(정렬, 중복 없음)를 낸다."""
    props = record.get("props") if isinstance(record.get("props"), dict) else {}
    sp = props.get("source_path") if isinstance(props.get("source_path"), str) else None
    rs = load_rules()
    ids: set[str] = set()
    fields: list[tuple[str, str]] = []
    for name in ("title", "body"):
        if isinstance(record.get(name), str):
            fields.append((name, record[name]))
    fields.extend(iter_strings(props, "props"))
    fields.extend(iter_strings(record.get("links") or [], "links"))
    for _, s in fields:
        for h in scan_text(s, sp, rs):
            ids.add(h.rule)
    return sorted(ids)
