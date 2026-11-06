"""수확 본문 정화. kb.intake의 Scrubber(차단 목록, 내부 주소, 토큰 권한 줄)를 그대로 쓰고 아래만 더한다.

- 이메일 주소가 든 줄(예외 없음. 사용자 본인 주소가 어디에도 남지 않게 한다)
- 차단 목록 항목에서 뽑은 앞부분 토큰(pve-node -> epyc-): 목록에 없는 같은 계열 이름도 뺀다
- 사설 대역의 자리표시 표기(192.168.x.x, 10.0.0/8), IPv6 사이트 로컬
- 내부 호스트 접미사(.localdomain .intranet .corp .ts.net .homelab)
- 토큰 권한 줄(token scopes, GitHub 세부 권한, 콜론 형식 OAuth 범위, Proxmox 권한 이름)

비밀 탐지는 줄 단위 제거가 아니라 원본 단위다. 한 줄이라도 걸리면 그 원본을 통째로 저장하지 않는다.
예외는 하나다: `KEY=<40자리 소문자 16진수>` 줄은 git 커밋 SHA로 보고(키 이름이 비밀스럽지 않을 때) 12자리로 줄여
저장한다. 고엔트로피 규칙이 SHA를 비밀로 오탐하기 때문이고, 줄여 두면 쓰기 코어의 자체 탐지도 같은 판정이 된다.
이 모듈은 파일, 네트워크, 프로세스를 쓰지 않는다. 적중한 내용은 어디에도 남기지 않는다(규칙 ID와 건수만).
"""
from __future__ import annotations

import ipaddress
import re

from kb.intake.scrub import Scrubber, has_internal_addr
from kb.write import secrets_scan

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

# 이메일 주소. 도메인 끝이 글자인 것만 본다: pkg@5.9.3, orval@8.46.0, @scope/pkg@1.0.0 같은 패키지 표기는 이메일이 아니다
_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@(?:[\w-]+\.)+[^\W\d_]{2,}(?![\w-])")
# 차단 목록 항목이 `영문4자이상-숫자…` 꼴이면 `영문-` 까지를 앞부분 토큰으로 삼는다(pve-node -> epyc-)
_STEM_SRC = re.compile(r"^([A-Za-z]{4,})-\d")

# 점 확장자가 이어지는 파일 이름(foo.corp.json)은 호스트가 아니다. intake의 INTERNAL_HOST와 같은 꼴이다
_EXTRA_HOST = re.compile(
    r"\b[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9_-]+)*\."
    r"(?:localdomain|intranet|corp|ts\.net|homelab)(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9])", re.I)

# 첫 옥텟이 사설, 루프백, 링크 로컬, CGNAT인 부분 표기. 숫자만으로 된 3성분(버전 10.x.x.x)은 건드리지 않는다
_V4_PART = re.compile(r"(?<![\w.])(\d{1,3})\.(\d{1,3}|[xX*])(?:\.(\d{1,3}|[xX*]))?(?:\.(\d{1,3}|[xX*]))?(/\d{1,2})?(?![\w])")
_V6_SITE_LOCAL = re.compile(r"(?<![\w:])fe[c-f][0-9a-f]:[0-9a-f:.]*[0-9a-f]", re.I)

_TOKEN_PERM = re.compile("|".join([
    r"\btoken\s+(?:scopes?|permissions?|privileges?)\b",
    r"\b(?:oauth|access|api|bearer|pat)\s+(?:scopes|permissions)\b",
    r"\bgranted\s+(?:scopes|permissions)\b",
    r"\brequired\s+scopes\b",
    r"\bscopes?\s*=\s*[\[\"'`]",
    r"\bscopes?\s*:\s*\[",
    r"\b(?:read|write|admin|delete):(?:org|packages|repo_hook|public_key|gpg_key|discussion|enterprise|user|project)\b",
    r"\buser:(?:email|follow)\b",
    # GitHub 세부 권한 표기와 GITHUB_TOKEN permissions 블록
    r"\b(?:contents|metadata|issues|pull[_ -]requests?|actions|administration|workflows|packages|deployments|"
    r"environments|checks|statuses|secrets|id-token)\s*[:=]\s*(?:read|write|admin|none)\b",
    # Proxmox API 토큰 권한: 역할 이름과 Path.Privilege 이름
    r"\bPVE(?:Auditor|Admin|VMAdmin|VMUser|SDNAdmin|SDNUser|DatastoreAdmin|DatastoreUser|PoolAdmin|PoolUser|"
    r"UserAdmin|TemplateUser)\b",
    r"\b(?:Sys|VM|Datastore|Pool|SDN|Permissions|Realm|Mapping)\.(?:Audit|Modify|PowerMgmt|Console|Allocate|"
    r"Backup|Migrate|Monitor|Syslog|Incoming|Snapshot|Clone|Use|Config\.\w+)\b",
]), re.I)


def clean_text(text: str) -> str:
    """줄바꿈을 \\n으로 맞추고 제어 문자와 ANSI 이스케이프를 지운다. 줄 경계는 바꾸지 않는다."""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    return _CTRL.sub("", _ANSI.sub("", t))


def _private_v4_part(first: int, second: str) -> bool:
    if first in (10, 127):
        return True
    wild = second in ("x", "X", "*")
    if first == 192 and (second == "168" or wild):
        return True
    if first == 169 and (second == "254" or wild):
        return True
    if first == 172:
        return wild or (second.isdigit() and 16 <= int(second) <= 31)
    if first == 100:
        return wild or (second.isdigit() and 64 <= int(second) <= 127)
    return False


def has_private_range(line: str) -> bool:
    """부분 표기 사설 대역. 3성분 이상이면서 와일드카드가 있거나 CIDR 접미사가 붙은 경우만 본다.
    10.8/18.3 ms 같은 측정값 표기를 CIDR로 읽지 않으려고 2성분은 보지 않는다."""
    for m in _V4_PART.finditer(line):
        text = m.group(0)
        comps = [g for g in m.groups()[:4] if g is not None]
        wildcard = re.search(r"[xX*]", text) is not None
        cidr = m.group(5) is not None
        if len(comps) < 3 or not (cidr or wildcard):
            continue
        if int(comps[0]) > 255:
            continue
        if _private_v4_part(int(comps[0]), comps[1]):
            return True
    for m in _V6_SITE_LOCAL.finditer(line):
        try:
            if ipaddress.IPv6Address(m.group(0)).is_site_local:
                return True
        except ValueError:
            continue
    return False


def extra_bad(line: str) -> bool:
    return bool(_EXTRA_HOST.search(line) or _TOKEN_PERM.search(line) or has_private_range(line))


def has_email(line: str) -> bool:
    return _EMAIL.search(line) is not None


class HarvestScrubber(Scrubber):
    """intake Scrubber + 위 확장. lines()는 부모의 것을 그대로 쓴다(걸린 줄은 통째로 빼고 건수만 센다)."""

    def __init__(self, deny: list[str] | None = None):
        super().__init__(deny)
        names = {d for d in (deny or []) if len(d) >= 3}
        stems = sorted({m.group(1).lower() + "-" for n in names if (m := _STEM_SRC.match(n))}, key=len, reverse=True)
        self._stem = re.compile("|".join(re.escape(x) for x in stems), re.I) if stems else None
        self.deny_entries = len(names)
        self.deny_stems = len(stems)

    def _denied(self, line: str) -> bool:
        return bool((self._deny is not None and self._deny.search(line)) or (self._stem is not None and self._stem.search(line)))

    def bad(self, line: str) -> bool:
        return super().bad(line) or self._denied(line) or has_email(line) or extra_bad(line)

    def audit(self, text: str) -> dict:
        """검증용. 범주별 적중 줄 수만 돌려주고 적중 내용은 돌려주지 않는다."""
        out = {"deny": 0, "internal_addr": 0, "email": 0, "extra": 0}
        for ln in text.splitlines():
            out["deny"] += self._denied(ln)
            out["internal_addr"] += has_internal_addr(ln)
            out["email"] += has_email(ln)
            out["extra"] += extra_bad(ln)
        return out


def audit_total(r: dict) -> int:
    return sum(r.values())


# 키 이름에 이런 말이 든 `KEY=<40자리 16진수>`는 실제 비밀일 수 있어 SHA로 보지 않는다(옛 GitHub 토큰이 40자리 16진수였다)
_SECRETISH_KEY = re.compile(r"TOKEN|SECRET|PASS|PWD|KEY|AUTH|CRED|PRIVATE|CERT|SIGN|SALT|API|BEARER|COOKIE|OAUTH|WEBHOOK|DSN", re.I)
_GIT_SHA_ENV = re.compile(r"(?m)^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]{2,63})([ \t]*=[ \t]*[\"']?)([0-9a-f]{40})(?![0-9A-Za-z_])")
SHORT_SHA = 12


def shorten_git_shas(text: str) -> tuple[str, int]:
    """줄 머리의 `KEY=<정확히 40자리 소문자 16진수>`를 앞 12자리와 …로 줄인다. 키 이름이 비밀스러우면 건드리지 않는다.
    (바뀐 본문, 줄인 값 수). 다른 길이, 대문자, 40자리가 아닌 고엔트로피 값은 그대로 두어 비밀 탐지가 계속 잡는다."""
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        if _SECRETISH_KEY.search(m.group(2)):
            return m.group(0)
        n += 1
        return m.group(1) + m.group(2) + m.group(3) + m.group(4)[:SHORT_SHA] + "…"
    return _GIT_SHA_ENV.sub(sub, text), n


def secret_rules(text: str) -> list[str]:
    """Gitleaks 기반 비밀 탐지(kb.write.secrets_scan 그대로). 적중 규칙 ID만 돌려준다. 경로 규칙은 쓰지 않는다."""
    if not text:
        return []
    return sorted({h.rule for h in secrets_scan.scan_text(text, None)})


def clip(text: str, max_bytes: int) -> tuple[str, bool]:
    """UTF-8로 max_bytes 이하가 되게 줄 경계에서 자른다. (본문, 잘렸는가)."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    cut = raw[:max_bytes].decode("utf-8", errors="ignore")
    nl = cut.rfind("\n")
    if nl > 0:
        cut = cut[:nl + 1]
    return cut, True


def scrub(sc: Scrubber, text: str) -> tuple[str, int]:
    """(남은 본문, 뺀 줄 수). 연속한 빈 줄은 하나로 줄이고 끝 공백을 지운다(내용이 없는 줄은 센 줄에 들지 않는다)."""
    body, n = sc.lines(clean_text(text))
    body = re.sub(r"\n{3,}", "\n\n", body).strip("\n")
    return (body + "\n") if body else "", n
