"""표시 본문(ADR 7.7). 원본 바이트를 NFC로 고정한 사람이 읽는 본문으로 바꾼다. 네트워크에 가지 않는다.

text_format: markdown | text | json | pdf_text. 표시 본문은 한 번 만들면 다시 계산하지 않는다(오프셋 안정).
"""
from __future__ import annotations

import io
import json
import re
import unicodedata
from dataclasses import dataclass

from kb.parse import hidden

TRAFILATURA_VERSION = "2.3.1"
EX_PASSTHROUGH = "passthrough-nfc@1"
EX_HTML = f"trafilatura-{TRAFILATURA_VERSION}+hidden@1"
EX_JSON = "json-canon@1"
EX_PDF = "pypdf-pages@1"
EX_TEXT = "text-nfc@1"
PDF_MIN_AVG_CHARS = 200


class DisplayError(Exception):
    pass


@dataclass
class Text:
    text: str
    fmt: str            # markdown | text | json | pdf_text
    extractor: str
    needs_ocr: bool = False
    pages: int | None = None


def nfc(s: str) -> str:
    s = unicodedata.normalize("NFC", s.replace("\r\n", "\n").replace("\r", "\n"))
    return s.replace("\x00", "").lstrip("﻿")


_META_CS = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([\w\-]+)""", re.I)


def decode(raw: bytes, ctype: str | None = None) -> str:
    cs = None
    m = re.search(r"charset\s*=\s*([\w\-]+)", ctype or "", re.I)
    if m:
        cs = m.group(1)
    if cs is None:
        mm = _META_CS.search(raw[:4096])
        if mm:
            cs = mm.group(1).decode("ascii", "ignore")
    for enc in ([cs] if cs else []) + ["utf-8"]:
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


# ---------------------------------------------------------------- Markdown

_FENCE = re.compile(r"(^|\n)(```|~~~)[^\n]*\n.*?\n\2[ \t]*(?=\n|$)", re.S)
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_TAG = re.compile(r"<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*/?>")
_ATTR = re.compile(r"""([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?""")
_VOID = frozenset({"br", "hr", "img", "input", "meta", "link", "source", "wbr"})


def _attrs_of(s: str) -> dict:
    return {m.group(1).lower(): (m.group(2) or m.group(3) or m.group(4) or "") for m in _ATTR.finditer(s)}


def _strip_hidden_inline(seg: str) -> str:
    """코드 밖 구간에서 숨김 태그(여는 태그부터 짝 닫는 태그까지)와 주석을 지운다."""
    seg = _COMMENT.sub("", seg)
    while True:
        changed = False
        pos = 0
        for m in _TAG.finditer(seg):
            if m.start() < pos:
                continue
            name = m.group(1).lower()
            if name in hidden.DROP_TAGS and name not in ("head",):
                pass
            elif not hidden.attrs_hidden(_attrs_of(m.group(2))):
                continue
            if m.group(0).endswith("/>") or name in _VOID:
                seg = seg[:m.start()] + seg[m.end():]
                changed = True
                break
            depth, i = 1, m.end()
            tag_re = re.compile(rf"<(/?){re.escape(m.group(1))}(?=[\s>/])[^<>]*>", re.I)
            for t in tag_re.finditer(seg, i):
                depth += -1 if t.group(1) else 1
                if depth == 0:
                    seg = seg[:m.start()] + seg[t.end():]
                    changed = True
                    break
            else:
                seg = seg[:m.start()] + seg[m.end():]       # 닫는 태그가 없으면 여는 태그만 지운다
                changed = True
            break
        if not changed:
            return seg


def markdown_display(raw: bytes, ctype: str | None = None) -> Text:
    s = decode(raw, ctype).replace("\r\n", "\n").replace("\r", "\n")
    out, pos = [], 0
    for m in _FENCE.finditer(s):
        out.append(_strip_hidden_inline(s[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_strip_hidden_inline(s[pos:]))
    return Text(nfc("".join(out)), "markdown", EX_PASSTHROUGH)


# ---------------------------------------------------------------- HTML

def _strip_html(html: str):
    import lxml.html
    html = re.sub(r"^\s*<\?xml[^>]*\?>", "", html)
    doc = lxml.html.document_fromstring(html)
    css = [el.text_content() for el in doc.iter("style")]
    doomed = []
    for sel in hidden.hidden_selectors(css):
        try:
            doomed.extend(doc.cssselect(sel))
        except Exception:  # noqa: BLE001 cssselect가 못 읽는 선택자는 건너뛴다
            continue
    for el in list(doc.iter()):
        if not isinstance(el.tag, str):
            doomed.append(el)           # 주석, 처리 명령
        elif el.tag.lower() in hidden.DROP_TAGS and el.tag.lower() != "head":
            doomed.append(el)
        elif hidden.attrs_hidden(el.attrib):
            doomed.append(el)
    for el in doomed:
        if el.getparent() is not None:
            el.drop_tree()
    return doc


def _fallback_text(doc) -> str:
    blocks = []
    for el in doc.iter("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "blockquote", "td", "th", "div"):
        if el.tag == "div" and any(c.tag in ("p", "div", "li", "h1", "h2", "h3") for c in el):
            continue
        t = " ".join(el.text_content().split())
        if t:
            blocks.append(("#" * int(el.tag[1]) + " " + t) if el.tag[0] == "h" and el.tag[1:].isdigit() else t)
    seen, out = set(), []
    for b in blocks:
        if b not in seen:
            seen.add(b)
            out.append(b)
    return "\n\n".join(out)


_UNESCAPE = re.compile(r"\\([_*\[\]`~])")


def html_display(raw: bytes, ctype: str | None = None) -> Text:
    import lxml.html
    import trafilatura
    doc = _strip_html(decode(raw, ctype))
    html = lxml.html.tostring(doc, encoding="unicode")
    md = None
    try:
        md = trafilatura.extract(html, output_format="markdown", include_tables=True, include_comments=False,
                                 include_links=False, include_images=False, favor_recall=True, deduplicate=False)
    except Exception:  # noqa: BLE001 추출기 오류는 대체 경로로 받는다
        md = None
    if md:
        md = _UNESCAPE.sub(r"\1", md)        # trafilatura가 붙인 마크다운 이스케이프(\_ 등)는 인용구 대조를 깨므로 지운다
    fallback = _fallback_text(doc)
    # 추출기가 본문을 지나치게 줄였으면(보일러플레이트 판정 오류) 숨김만 지운 대체 본문을 쓴다
    if not md or len(md.strip()) < 0.5 * len(fallback):
        md = fallback
    return Text(nfc(md.strip() + "\n"), "markdown", EX_HTML)


# ---------------------------------------------------------------- JSON, PDF, 텍스트

def json_display(raw: bytes, ctype: str | None = None) -> Text:
    try:
        v = json.loads(decode(raw, ctype))
    except ValueError as e:
        raise DisplayError(f"json_invalid: {e}") from e
    return Text(nfc(json.dumps(v, ensure_ascii=False, sort_keys=True, indent=2) + "\n"), "json", EX_JSON)


def pdf_display(raw: bytes, ctype: str | None = None) -> Text:
    from pypdf import PdfReader
    try:
        rd = PdfReader(io.BytesIO(raw))
        pages = [(p.extract_text() or "").strip() for p in rd.pages]
    except Exception as e:  # noqa: BLE001
        raise DisplayError(f"pdf_unreadable: {type(e).__name__}: {e}") from e
    n = max(1, len(pages))
    avg = sum(len(p) for p in pages) / n
    if avg < PDF_MIN_AVG_CHARS:
        return Text("", "pdf_text", EX_PDF, needs_ocr=True, pages=len(pages))
    return Text(nfc("\n\n".join(p for p in pages if p) + "\n"), "pdf_text", EX_PDF, pages=len(pages))


def text_display(raw: bytes, ctype: str | None = None) -> Text:
    return Text(nfc(decode(raw, ctype)), "text", EX_TEXT)


def sniff(raw: bytes, ctype: str | None, url: str | None = None) -> str:
    """hint: markdown | html | json | pdf | text."""
    ct = (ctype or "").split(";")[0].strip().lower()
    path = (url or "").split("?")[0].lower()
    if ct == "application/pdf" or raw[:5] == b"%PDF-" or path.endswith(".pdf"):
        return "pdf"
    if ct in ("text/markdown", "text/x-markdown") or path.endswith((".md", ".markdown")):
        return "markdown"
    if ct in ("text/html", "application/xhtml+xml"):
        return "html"
    if ct == "application/json" or ct.endswith("+json") or path.endswith(".json"):
        return "json"
    head = raw[:512].lstrip().lower()
    if head.startswith((b"<!doctype html", b"<html")):
        return "html"
    return "text"


_BY_HINT = {"markdown": markdown_display, "html": html_display, "json": json_display, "pdf": pdf_display,
            "text": text_display}


def display_text(raw: bytes, ctype: str | None = None, *, hint: str | None = None, url: str | None = None,
                 needs_pdf: bool = False) -> Text:
    """표시 본문. hint가 없으면 content-type과 URL로 정한다. PDF는 needs_pdf 선언이 있거나 PDF로 보일 때만 푼다."""
    h = hint or sniff(raw, ctype, url)
    if h == "pdf" and not (needs_pdf or sniff(raw, ctype, url) == "pdf"):
        h = "text"
    return _BY_HINT[h](raw, ctype)
