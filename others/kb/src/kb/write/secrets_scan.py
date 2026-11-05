"""쓰기 시 비밀 탐지. Gitleaks v8.30.1 기본 규칙(schemas/secrets/gitleaks.toml, MIT)을 Python re로 읽는다.

판정은 Gitleaks와 같게 한다.
- keywords로 미리 거른다(소문자 부분 문자열).
- 비밀값은 secretGroup, 없으면 첫 캡처 그룹, 없으면 전체 일치다.
- entropy가 있는 규칙은 비밀값의 Shannon 엔트로피(비트/문자)가 그 값 이상일 때만 적중이다.
- 전역 allowlist(regexes, stopwords, paths)와 규칙별 allowlist를 regexTarget(secret|match|line) 대로 적용한다.
- 정규식이 없는 경로 규칙 pkcs12-file은 뺀다. path 조건이 있는 규칙과 경로 허용 목록은 scan_text에 파일 경로가
  주어질 때만 쓴다. 레코드 검사(scan_record)는 호출자가 보낸 값을 경로로 믿지 않으므로 경로 없이 검사한다.
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


def _secret_group(rule: Rule, m: re.Match) -> int:
    if rule.group is not None:
        return rule.group
    for i in range(1, m.re.groups + 1):
        if m.group(i):
            return i
    return 0


def _secret_of(rule: Rule, m: re.Match) -> str:
    return m.group(_secret_group(rule, m)) or ""


def scan_text(text: str, source_path: str | None = None, rs: RuleSet | None = None) -> list[Hit]:
    """text에서 비밀 후보를 찾는다. 같은 규칙 ID가 여러 번 맞아도 구간마다 낸다."""
    return [h for h, _, _ in _scan(text, source_path, rs)]


def _scan(text: str, source_path: str | None, rs: RuleSet | None) -> list[tuple[Hit, int, int]]:
    """scan_text의 본체. 적중마다 비밀값 구간(secretGroup 등)의 시작과 끝을 함께 낸다."""
    if not text:
        return []
    rs = rs or load_rules()
    if source_path and any(r.search(source_path) for r in rs.allow.paths):
        return []
    low = text.lower()
    hits: list[tuple[Hit, int, int]] = []
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
            g = _secret_group(rule, m)
            hits.append((Hit(rule.id, m.start(), m.end()), m.start(g), m.end(g)))
    for m in _PRIVATE_KEY.finditer(text):
        hits.append((Hit(EXTRA_PRIVATE_KEY, m.start(), m.end()), m.start(), m.end()))
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
        hits.append((Hit(EXTRA_ENV_LINE, m.start(), m.end()), m.start(2), m.end(2)))
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


_DIGEST = re.compile(r"(?:^|(?<=:))[0-9a-f]{16,128}(?=$|:)")
# 칸 이름의 마지막 낱말이 이 말이면 그 칸 다음 값은 비밀의 이름표다(`api_key:`, `accessToken:`). gitleaks
# generic-api-key의 키워드(access, auth, api, credential, creds, key, passw(or)d, secret, token)에 흔한 말을 더했다.
_CRED_WORD = re.compile(r"(?:api)?keys?|api|tokens?|secrets?|passw(?:or)?ds?|pass|pwd|auth|credentials?|creds?"
                        r"|pat|access|bearer", re.I)
_WORD_SPLIT = re.compile(r"[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])")


def _names_credential(label: str) -> bool:
    """칸 이름이 비밀값의 이름인가. 마지막 낱말만 본다: `api-token-rotation`은 아니고 `github_token`은 그렇다."""
    words = [w for w in _WORD_SPLIT.split(label) if w]
    return bool(words) and bool(_CRED_WORD.fullmatch(words[-1]))


def _mask_digests(text: str, digest_tail: bool) -> str:
    segs = text.split(":")
    if digest_tail and len(segs) > 1 and _DIGEST.fullmatch(segs[-1]):
        text = ":".join(segs[:-1] + ["digest"])

    def sub(m: re.Match) -> str:
        label = text[:m.start()].rstrip(":").rsplit(":", 1)[-1]
        return m.group(0) if _names_credential(label) else "digest"
    return _DIGEST.sub(sub, text)


def scan_key(text: str, *, digest_tail: bool = False) -> list[str]:
    """식별자(멱등 키, 레코드 ID, 타입 이름, 삭제 사유)를 검사한다. 적중한 규칙 ID(정렬, 중복 없음)를 낸다.

    `이름:내용해시` 꼴의 키가 흔하므로, `:`로 나뉜 칸이 16~128자 소문자 16진수뿐이면 다이제스트로 보고 검사에서 뺀다.
    바로 앞 칸이 비밀값의 이름일 때(마지막 낱말이 key, token, secret, access 같은 말: `api_key`, `accessToken`)만
    빼지 않는다. `api-token-rotation`처럼 낱말 중간에 그 말이 있을 뿐인 칸은 이름표가 아니다.
    digest_tail=True는 쓰는 쪽이 마지막 칸을 내용 해시로 직접 만들었다는 뜻이고, 그 칸은 앞 칸과 상관없이 뺀다.
    접두어가 있는 비밀(ghp_, sk-ant-, AKIA 등)은 16진수만의 칸이 아니어서 언제나 검사한다.
    한계: 이름이 평범한 칸에 든 16진수만의 비밀값은 이 검사로 잡지 못한다.
    """
    if not isinstance(text, str) or not text:
        return []
    return sorted({h.rule for h in scan_text(_mask_digests(text, digest_tail), None)})


def scan_record(record: dict) -> list[str]:
    """레코드의 제목, 본문, props(값과 이름), 링크의 전 문자열 필드를 검사한다. 적중한 규칙 ID(정렬, 중복 없음)를 낸다.

    props 이름에서 단독으로 걸리는 비밀은 put_record가 이 검사 전에 거부한다(record.reject_secret_key). 여기서는
    이름과 값에 쪼개진 비밀을 잡으려고 이름도 함께 본다.

    경로 허용 목록은 쓰지 않는다. props.source_path 같은 호출자 쪽 경로 표시는 신뢰할 수 없다(png, node_modules를
    흉내 내면 검사를 건너뛸 수 있었다). 파일 경로 조건이 필요한 쪽은 서버가 직접 읽은 파일에 scan_text(text, path)를 쓴다.

    필드마다 검사한 뒤, 모든 문자열을 줄바꿈 없이 이은 글과 줄바꿈으로 이은 글도 검사한다. 이은 글의 적중은
    비밀값 구간 자체가 필드 경계를 넘을 때만 센다. 비밀이 제목, 본문, props 사이에 쪼개진 경우는 잡고, 한 필드의
    이름표(제목 `Rotate the key:`)와 다른 필드의 평범한 값(본문의 해시)이 붙어서 생기는 적중은 세지 않는다.
    한계: 쪼갠 조각 사이에 다른 글자가 끼거나 인코딩, 순서를 바꾼 경우는 잡지 못한다.
    """
    props = record.get("props") if isinstance(record.get("props"), dict) else {}
    rs = load_rules()
    ids: set[str] = set()
    fields: list[tuple[str, str]] = []
    for name in ("title", "body"):
        if isinstance(record.get(name), str):
            fields.append((name, record[name]))
    fields.extend(iter_strings(props, "props"))
    fields.extend(iter_strings(record.get("links") or [], "links"))
    for _, s in fields:
        for h in scan_text(s, None, rs):
            ids.add(h.rule)
    texts = [s for _, s in fields if s]
    if len(texts) > 1:
        for sep in ("", "\n"):
            cuts, pos = [], 0
            for t in texts[:-1]:
                pos += len(t)
                cuts.append(pos)          # 이 위치 앞은 앞 필드, sep 뒤는 다음 필드
                pos += len(sep)
            for h, a, b in _scan(sep.join(texts), None, rs):
                if any(a < c and b > c + len(sep) for c in cuts):   # 비밀값이 두 필드에 걸친다
                    ids.add(h.rule)
    return sorted(ids)


def editor_hits(record: dict) -> list[dict]:
    """입력 이름/값을 되풀이하지 않는 순번 경로와 CP/UTF-16 구간(ADR-0005 7.2).

    단일 필드와 필드 경계에 걸친 비밀을 기존 scan_record와 같은 규칙으로 검사한다.
    캐시에는 규칙만 남기고 입력이나 결과를 저장하지 않는다.
    """
    def walk(obj, prefix):
        if isinstance(obj, str):
            yield prefix, obj
        elif isinstance(obj, dict):
            for i, (key, val) in enumerate(obj.items()):
                yield f"{prefix}[{i}].name", str(key)
                yield from walk(val, f"{prefix}[{i}].value")
        elif isinstance(obj, (list, tuple)):
            for i, val in enumerate(obj):
                yield from walk(val, f"{prefix}[{i}]")

    fields = [(f"record.{k}", record[k]) for k in ("title", "body") if isinstance(record.get(k), str)]
    fields.extend(walk(record.get("props") or {}, "record.props"))
    fields.extend(walk(record.get("links") or [], "record.links"))
    found = {}

    def add(field, text, rule, start, end):
        key = field, rule, start, end
        found[key] = {"field": field, "rule": rule, "start": start, "end": end,
                      "start_u16": len(text[:start].encode("utf-16-le")) // 2,
                      "end_u16": len(text[:end].encode("utf-16-le")) // 2}

    rs = load_rules()
    for field, text in fields:
        for hit in scan_text(text, None, rs):
            add(field, text, hit.rule, hit.start, hit.end)
    fields = [(f, t) for f, t in fields if t]
    if len(fields) > 1:
        for sep in ("", "\n"):
            spans, cuts, pos = [], [], 0
            for field, text in fields:
                spans.append((field, text, pos, pos + len(text)))
                pos += len(text)
                cuts.append(pos)
                pos += len(sep)
            for hit, a, b in _scan(sep.join(t for _, t in fields), None, rs):
                if not any(a < cut and b > cut + len(sep) for cut in cuts[:-1]):
                    continue
                for field, text, start, end in spans:
                    left, right = max(start, hit.start), min(end, hit.end)
                    if left < right:
                        add(field, text, hit.rule, left - start, right - start)
    return list(found.values())


def editor_rule_contract() -> dict:
    """FW1 공개 산출물의 판/정규 해시. 요청 데이터는 포함하지 않는다."""
    import hashlib
    import json
    artifact = json.loads((paths.share_dir() / "docs/contracts/first-party-secret-rules-v1.json").read_text())
    blob = json.dumps(artifact, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"version": artifact["version"], "sha": hashlib.sha256(blob).hexdigest()}
