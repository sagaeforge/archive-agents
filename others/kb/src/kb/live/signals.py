"""기계 신호 검사 M01~M24(sources-inventory-g 3.2). 순수 함수다: 이미 받은 본문과 스냅샷 ID를 받아 Sig를 돌려준다.
네트워크는 쓰지 않는다. 한 신호만으로 죽음을 확정하지 않는다는 것은 rules.py의 몫이고, 여기서는 확정력(kind)만 붙인다."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from kb.live.model import Sig

DAY_MS = 86_400_000
README_HEAD = 8000


def parse_ms(s) -> int | None:
    """ISO, YYYY-MM-DD, RFC 2822 날짜 -> epoch ms. 못 읽으면 None."""
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return int(s)
    s = str(s).strip()
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            d = parsedate_to_datetime(s)
        except (TypeError, ValueError):
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def iso_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def _repo_dict(doc: dict) -> dict:
    """REST(repos/O/R)와 GraphQL(repository) 결과를 같은 모양으로."""
    if not isinstance(doc, dict):
        return {}
    last = doc.get("last_commit_at") or doc.get("pushed_at") or doc.get("pushedAt")
    br = (doc.get("defaultBranchRef") or {}).get("target", {}).get("committedDate") if isinstance(doc.get("defaultBranchRef"), dict) else None
    return {"archived": bool(doc.get("archived", doc.get("isArchived", False))),
            "full_name": doc.get("full_name") or doc.get("nameWithOwner"),
            "last_commit_at": br or last, "html_url": doc.get("html_url")}


# ---------------------------------------------------------------- 저장소 M01~M05
def m01_archived(doc: dict, snap=None) -> Sig | None:
    """저장소 종료 확정이지 프로젝트 종료가 아니다. 양방향으로 틀린다(미보관 사망 7개를 놓치고 후속 명시 5개가 있다)."""
    r = _repo_dict(doc)
    if r["archived"]:
        return Sig("M01", "archive", snap, '"archived": true', {"full_name": r["full_name"]})
    return None


def m02_renamed(doc: dict, requested: str, snap=None) -> Sig | None:
    r = _repo_dict(doc)
    fn = r["full_name"]
    if fn and requested and fn.lower() != requested.lower():
        return Sig("M02", "move", snap, fn, {"canonical": fn, "requested": requested})
    return None


def m03_not_found(status: int | None, snap=None) -> Sig | None:
    """조회 결과 없음: 의심. 비공개 전환과 구분할 수 없다."""
    return Sig("M03", "suspect", snap, f"HTTP {status}", {"status": status}) if status in (404, 410) else None


def m04_commit_age(doc: dict, now_ms: int, snap=None, min_days: int = 365) -> Sig | None:
    r = _repo_dict(doc)
    t = parse_ms(r["last_commit_at"])
    if t is None:
        return None
    days = (now_ms - t) // DAY_MS
    return Sig("M04", "suspect", snap, str(r["last_commit_at"]), {"days": int(days)}) if days >= min_days else None


_SUCC = (r"(?:moved\s+to|has\s+moved\s+to|superseded\s+by|replaced\s+by|succeeded\s+by|continued\s+(?:at|in)|"
         r"migrate\s+to|please\s+use|use|see|renamed\s+to|now\s+(?:at|lives\s+at))")
_REPO_REF = r"(?:https?://github\.com/)?\[?`?([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)`?\]?(?:\([^)]*\))?(?=[\s.,;:)\]]|$)"
_SUCC_RE = re.compile(_SUCC + r"\s+(?:the\s+(?:new|official)\s+(?:repo(?:sitory)?|project)\s+(?:at\s+)?)?" + _REPO_REF, re.I)
_PKG_SUCC_RE = re.compile(r"(?:use|renamed\s+to|moved\s+to|replaced\s+by|switch\s+to)\s+(@[\w.-]+/[\w.-]+|[\w][\w.-]+)\s*(?:instead|going\s+forward)?", re.I)
_DECL_RE = re.compile(
    r"\b(?:this|the)\s+(?:project|repository|repo|package|tool|library)\s+(?:is|has\s+been|was)\s+(?:now\s+)?"
    r"(?:archived|deprecated|unmaintained|no\s+longer\s+(?:maintained|supported|developed)|sunset|discontinued|abandoned)\b"
    r"|\b(?:no\s+longer\s+(?:maintained|actively\s+maintained)|is\s+(?:now\s+)?(?:deprecated|archived|unmaintained))\b"
    r"|\bhas\s+(?:moved|been\s+(?:moved|replaced|superseded))\s+(?:to|by)\b|\bsuperseded\s+by\b|\bmoved\s+to\s+(?:https?://)?github\.com",
    re.I)
_FENCE = re.compile(r"^\s*(```|~~~)")
_LIST_HEAD = re.compile(r"archiv|deprecated|legacy|retired|former|unmaintained\s+(?:servers|projects|repos)", re.I)


def repo_slug(s: str | None) -> str | None:
    if not s:
        return None
    m = re.search(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)\s*$", s.strip().rstrip("/"))
    return f"{m.group(1)}/{m.group(2)}".lower() if m else None


def m05_readme(text: str, self_name: str = "", snap=None) -> Sig | None:
    """README 앞 8,000자의 선언 문구. 코드 블록과 '보관 목록' 절 안의 줄은 제외한다(modelcontextprotocol/servers 오탐)."""
    head = (text or "")[:README_HEAD]
    in_fence, heading = False, ""
    me = (self_name or "").lower()
    for ln in head.splitlines():
        if _FENCE.match(ln):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if ln.lstrip().startswith("#"):
            heading = ln
            continue
        if _LIST_HEAD.search(heading) and re.match(r"\s*[-*+|]", ln):
            continue
        if re.match(r"\s*[-*+]\s+(?:\[[^\]]+\]\([^)]*\)|\S+)\s*[-–—:]", ln) and _LIST_HEAD.search(ln) and not re.search(r"\bthis\b", ln, re.I):
            continue
        if _DECL_RE.search(ln):
            succ = None
            for m in _SUCC_RE.finditer(ln):
                cand = repo_slug(m.group(1))
                if cand and cand != me:
                    succ = cand
                    break
            return Sig("M05", "decl", snap, ln.strip()[:300], {"successor": succ})
    return None


# ---------------------------------------------------------------- 패키지 M06~M09
def m06_npm_deprecated(doc: dict, snap=None) -> Sig | None:
    """latest 버전의 deprecated만 센다. 과거 버전만 deprecated인 15개는 오탐이다."""
    try:
        latest = doc["dist-tags"]["latest"]
        msg = doc["versions"][latest].get("deprecated")
    except (KeyError, TypeError, AttributeError):
        return None
    if not msg or not isinstance(msg, str):
        return None
    succ = None
    m = _PKG_SUCC_RE.search(msg)
    if m and m.group(1).lower() not in ("this", "it", "the", "another", "a"):
        succ = m.group(1)
    return Sig("M06", "decl", snap, msg[:300], {"successor": succ, "latest": latest, "package_successor": True})


def m07_pypi_inactive(doc: dict, snap=None) -> Sig | None:
    cl = (doc.get("info") or {}).get("classifiers") or []
    for c in cl:
        if str(c).startswith("Development Status :: 7 - Inactive"):
            return Sig("M07", "decl", snap, c)
    return None


def m08_pep792(doc: dict, snap=None) -> Sig | None:
    """project-status. 지금은 변별력이 없다(18개 전부 active). active 외 값이 나오면 신호로 쓴다."""
    st = (doc.get("project-status") or {}).get("status") if isinstance(doc.get("project-status"), dict) else doc.get("project-status")
    if st in ("deprecated", "archived", "quarantined"):
        return Sig("M08", "decl", snap, str(st))
    return None


def m09_publish_age(iso: str | None, now_ms: int, snap=None, min_days: int = 365) -> Sig | None:
    t = parse_ms(iso)
    if t is None:
        return None
    days = (now_ms - t) // DAY_MS
    return Sig("M09", "suspect", snap, str(iso), {"days": int(days)}) if days >= min_days else None


# ---------------------------------------------------------------- 문서 M10~M15
def _norm_url(u: str) -> str:
    p = urlsplit(u or "")
    host = (p.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    return host + (p.path.rstrip("/") or "") + (("?" + p.query) if p.query else "")


def m10_http_404(first_status: int | None, final_status: int | None, snap=None) -> Sig | None:
    if final_status == 404 or (final_status is None and first_status == 404):
        return Sig("M10", "suspect", snap, "HTTP 404", {"status": 404})
    return None


def m11_redirect(requested: str, final_url: str | None, first_status: int | None, body: bytes | str | None = None, snap=None) -> Sig | None:
    """3xx로 최종 URL이 바뀌면 renamed. 메타 리프레시는 3xx가 아니므로 짧은 본문의 refresh 태그로 따로 본다."""
    if final_url and first_status and 300 <= first_status < 400 and _norm_url(final_url) != _norm_url(requested):
        return Sig("M11", "move", snap, final_url, {"canonical": final_url, "requested": requested})
    if body is not None and len(body) < 1500:
        t = body.decode("utf-8", "ignore") if isinstance(body, bytes) else body
        m = re.search(r'http-equiv=["\']refresh["\'][^>]*content=["\'][^"\']*url=([^"\'>\s]+)', t, re.I)
        if m:
            return Sig("M11", "move", snap, m.group(1), {"canonical": m.group(1), "requested": requested, "meta_refresh": True})
    return None


_TOMB_TITLE = re.compile(r"is\s+no\s+longer\s+available|\(removed\)|\bremoval\b|\bhas\s+been\s+removed\b", re.I)
_TOMB_BODY = re.compile(r"(?:is|are|was|has\s+been)\s+(?:no\s+longer\s+available|removed)\b|\bno\s+longer\s+available\b", re.I)


def m12_tombstone(title: str | None, body: str | None, snap=None) -> Sig | None:
    """묘비 제목. 제목이 없거나 약하면 본문 앞 600자까지 읽는다."""
    if title and _TOMB_TITLE.search(title):
        return Sig("M12", "removed", snap, title.strip()[:200])
    head = (body or "")[:600]
    m = _TOMB_BODY.search(head)
    if m and (len(body or "") < 3000):
        return Sig("M12", "removed", snap, head[max(0, m.start() - 60):m.end() + 60].strip())
    return None


def m13_llms_txt(llms_text: str | None, url: str, snap=None) -> Sig | None:
    """llms.txt 색인에 없음: 의심(별칭 페이지도 빠진다)."""
    if llms_text is None:
        return None
    p = urlsplit(url).path.rstrip("/")
    if p and p not in llms_text and p + ".md" not in llms_text:
        return Sig("M13", "suspect", snap, p, {"path": p})
    return None


_STATUS_ROW = re.compile(r"\b(Removed|\[DEPRECATED\]|Deprecated|No longer (?:available|supported))\b", re.I)
_VER = re.compile(r"\bv?(\d+\.\d+\.\d+)\b")


def m14_status_row(text: str, name: str, snap=None) -> Sig | None:
    """명령·도구 표의 상태 행. name이 든 표 행/목록 줄에 Removed, [DEPRECATED]가 있을 때."""
    nm = re.escape(name)
    for ln in (text or "").splitlines():
        if not re.search(r"(?<![\w/-])" + nm + r"(?![\w-])", ln):
            continue
        m = _STATUS_ROW.search(ln)
        if not m:
            continue
        word = m.group(1).lower()
        kind = "removed" if word.startswith(("removed", "no longer")) else "deprecated"
        v = _VER.search(ln)
        return Sig("M14", kind, snap, ln.strip()[:300], {"version": v.group(1) if v else None, "conditions": cond_of(ln)})
    return None


def m15_glossary(text: str, term: str, snap=None) -> Sig | None:
    """용어집 'Deprecated and renamed terms' 표."""
    m = re.search(r"Deprecated and renamed terms(.*?)(?:\n#{1,4}\s|\Z)", text or "", re.I | re.S)
    if not m:
        return None
    for ln in m.group(1).splitlines():
        cells = [c.strip(" `*") for c in ln.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0].lower() == term.lower():
            return Sig("M15", "move", snap, ln.strip(), {"canonical": cells[1], "requested": term})
    return None


# ---------------------------------------------------------------- 변경 이력 M16, M17
_CL_HEAD = re.compile(r"^\s*(?:[-*+]\s+)?(?:\*\*)?(Removed|Deprecated|Dropped|Unshipped|Renamed|Replaced|Retired|Sunset)\b(.*)", re.I)
_CL_NEG = re.compile(r"\bno\s+longer\s+available\b|\bis\s+now\s+a\s+no-op\b|\bno-op\b", re.I)
_UI_WORDS = re.compile(r"\b(label|hint|tip|tips|banner|prompt|dialog|spinner|animation|notice|message|messages|wording|footer|header|"
                       r"indicator|badge|tooltip|cursor|padding|border|color|colour|flicker|duplicate|redundant|extra|stray|unnecessary)\b", re.I)
_PROMO = re.compile(r"\((?:research\s+preview|beta|experimental)\)\s+label", re.I)
_REVIVE = re.compile(r"\b(Un-?deprecat\w*|Re-?introduc\w*|Restor\w*|Revert\w*|Brought\s+back|Reinstat\w*)\b", re.I)
_VERHEAD = re.compile(r"^\s*#{1,4}\s*v?(\d+\.\d+\.\d+(?:[-\w.]*)?)")
_COND_RES = (re.compile(r"\bon\s+(?:Max|Pro|Team|Enterprise|Free|Plus)\s+plans?\b|\bfor\s+(?:Max|Pro|Team|Enterprise|Free|Plus)\s+(?:users|plans?)\b", re.I),
             re.compile(r"\b(?:for|on|with|when\s+using)\s+(?:ChatGPT\s+login|API\s+key|Bedrock|Vertex|Foundry|Windows|macOS|Linux|WSL|native\s+builds?)\b", re.I),
             re.compile(r"\b(?:Opus|Sonnet|Haiku|GPT)[-\s]?\d[\w.]*(?:\s+\d[\w.]*)?\b", re.I),
             re.compile(r"\b(?:only\s+(?:on|for|in|when)\s+[^.;,]{3,40})", re.I))


def cond_of(line: str) -> list:
    """제거가 적용되는 조건(모델, 요금제, 인증, 플랫폼). 있으면 partial 후보다(H08)."""
    out = []
    for r in _COND_RES:
        for m in r.finditer(line or ""):
            s = m.group(0).strip()
            if s and s.lower() not in [x.lower() for x in out]:
                out.append(s)
    return out


def m16_changelog(text: str, name: str, snap=None) -> list:
    """변경 이력에서 name이 든 제거·폐기·개명 후보. UI 정리 문구는 후보에서 뺀다(54건 중 23건)."""
    nm = re.escape(name)
    pat = re.compile(r"(?<![\w/-])`?" + nm + r"`?(?![\w-])")
    ver, out = None, []
    for ln in (text or "").splitlines():
        v = _VERHEAD.match(ln)
        if v:
            ver = v.group(1)
            continue
        h = _CL_HEAD.match(ln)
        neg = _CL_NEG.search(ln)
        if not (h or neg) or not pat.search(ln):
            continue
        rest = (h.group(2) if h else ln)[:160]
        if _PROMO.search(ln):
            out.append(Sig("M16", "info", snap, ln.strip()[:300], {"version": ver, "promotion": True}))
            continue
        # name이 제거 대상이 아니라 UI 문구의 일부이면 제외한다. 대상이 명령·플래그 형태(`/x`, `--x`, 코드 스팬)이면 유지한다
        target_is_code = bool(re.search(r"`[^`]*" + nm + r"[^`]*`", ln)) or name.startswith(("/", "-"))
        if _UI_WORDS.search(rest) and not (h and h.group(1).lower() in ("renamed", "replaced") and target_is_code):
            if not re.search(r"\b(command|flag|option|tool|setting|env|variable|model|feature|mode|API|SDK)\b", rest, re.I):
                continue
        verb = (h.group(1) if h else "no longer available").lower()
        out.append(Sig("M16", "candidate", snap, ln.strip()[:300], {"version": ver, "verb": verb, "conditions": cond_of(ln)}))
    return out


def m17_reversal(text: str, name: str, snap=None) -> Sig | None:
    nm = re.escape(name)
    pat = re.compile(r"(?<![\w/-])`?" + nm + r"`?(?![\w-])")
    ver = None
    for ln in (text or "").splitlines():
        v = _VERHEAD.match(ln)
        if v:
            ver = v.group(1)
            continue
        if _REVIVE.search(ln) and pat.search(ln):
            return Sig("M17", "revive", snap, ln.strip()[:300], {"version": ver})
    return None


# ---------------------------------------------------------------- 제품 M18, M19, 모델 M20
def m18_codex_feature(listing: str, name: str, snap=None) -> Sig | None:
    """`codex features list` 한 줄: <name> <stage> <true|false>. removed+true는 기능 생존이다."""
    for ln in (listing or "").splitlines():
        p = ln.split()
        if len(p) >= 3 and p[0] == name:
            stage, enabled = p[1].lower(), p[2].lower() == "true"
            kind = "info" if (stage == "removed" and enabled) else ("removed" if stage == "removed" else
                   "deprecated" if stage == "deprecated" else "info")
            return Sig("M18", kind, snap, ln.strip(), {"stage": stage, "enabled": enabled})
    return None


def m19_maturity(text: str, snap=None) -> Sig | None:
    m = re.search(r"\b(Experimental|Beta|Research preview|Alpha)\b[^\n]{0,120}(?:may\s+(?:remove|change)|subject\s+to\s+change)", text or "", re.I)
    return Sig("M19", "info", snap, m.group(0)[:200], {"label": m.group(1).lower()}) if m else None


_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_NOT_SOONER = re.compile(r"not\s+sooner\s+than", re.I)


def m20_model_table(text: str, model_id: str, now_ms: int, snap=None) -> Sig | None:
    """공식 수명 표. 'Not sooner than'은 퇴역일이 아니므로 날짜로 세지 않는다. 퇴역 날짜가 미래면 scheduled_removal,
    행이 Retired이면 removed 후보(교차 확인은 rules)."""
    for ln in (text or "").splitlines():
        if model_id not in ln:
            continue
        low = ln.lower()
        dates = [d for d in _DATE.findall(ln)]
        if _NOT_SOONER.search(ln):
            # 날짜 앞에 'Not sooner than'이 붙은 것은 제외하고 남은 날짜만 본다
            dates = [d for d in dates if not re.search(r"not\s+sooner\s+than\s+" + re.escape(d), ln, re.I)]
            if not dates:
                return Sig("M20", "info", snap, ln.strip()[:300], {"not_sooner_than": True})
        ms = [parse_ms(d) for d in dates]
        if "retired" in low:
            return Sig("M20", "removed", snap, ln.strip()[:300], {"retired": True, "dates": dates})
        fut = [d for d, t in zip(dates, ms) if t and t > now_ms]
        if fut:
            return Sig("M20", "date", snap, ln.strip()[:300], {"removal_date": max(fut), "conditions": cond_of(ln)})
        if dates:
            return Sig("M20", "info", snap, ln.strip()[:300], {"past_date": max(dates), "recheck": True})
        return Sig("M20", "info", snap, ln.strip()[:300])
    return None


# ---------------------------------------------------------------- 레지스트리, 큐레이션, 피드, 실행
def m21_mcp_registry(doc: dict, name: str, snap=None) -> Sig | None:
    """MCP Registry status. isLatest 버전만 센다."""
    for it in (doc.get("servers") or []) if isinstance(doc, dict) else []:
        sv = it.get("server") or {}
        if sv.get("name") != name:
            continue
        meta = (it.get("_meta") or {}).get("io.modelcontextprotocol.registry/official") or {}
        if not meta.get("isLatest", True):
            continue
        st = meta.get("status")
        if st == "deprecated":
            return Sig("M21", "decl", snap, f"status={st}", {"version": sv.get("version")})
        if st == "deleted":
            return Sig("M21", "removed", snap, f"status={st}", {"version": sv.get("version")})
    return None


def m22_curated_flag(row: dict, snap=None) -> Sig | None:
    """큐레이션 목록의 자체 플래그. 약하다(archived 1건이 Active=TRUE였다). 참고 신호이고 규칙은 쓰지 않는다."""
    if str(row.get("Active", "")).upper() == "FALSE" or str(row.get("Stale", "")).upper() == "TRUE":
        return Sig("M22", "info", snap, json.dumps({k: row.get(k) for k in ("Active", "Stale")}))
    return None


def m23_feed_age(body: bytes | str, now_ms: int, content_type: str | None = None, snap=None, min_days: int = 90) -> Sig | None:
    """피드 생존. 200 응답이 HTML이면 즉시 신호. 최신 항목 경과일은 피드 생존만 말한다(소스 생존과 별개)."""
    t = body.decode("utf-8", "ignore") if isinstance(body, bytes) else body
    head = t.lstrip()[:200].lower()
    if head.startswith(("<!doctype html", "<html")) or (content_type and "html" in content_type.lower() and "<rss" not in t[:2000] and "<feed" not in t[:2000]):
        return Sig("M23", "suspect", snap, "feed_is_html", {"html": True})
    dates = re.findall(r"<(?:pubDate|updated|published|dc:date)>\s*([^<]+?)\s*<", t)
    ms = [x for x in (parse_ms(d) for d in dates) if x]
    if not ms:
        return None
    days = (now_ms - max(ms)) // DAY_MS
    return Sig("M23", "suspect", snap, iso_day(max(ms)), {"days": int(days)}) if days >= min_days else Sig("M23", "info", snap, iso_day(max(ms)), {"days": int(days)})


def m24_executed(result: dict | None, snap=None) -> Sig | None:
    """실행 검증은 비용·계정 의존이라 이 모듈이 돌리지 않는다. 호출자가 {ok, version, output}을 주면 신호로 바꾼다.
    exit 코드를 믿지 않고 output 인용구가 있을 때만 신호가 된다."""
    if not result or not result.get("output"):
        return None
    return Sig("M24", "removed" if result.get("ok") is False else "info", snap, str(result["output"])[:200], {"version": result.get("version")})
