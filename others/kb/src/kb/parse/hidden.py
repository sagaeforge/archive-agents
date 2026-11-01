"""숨김 판정(HTML과 Markdown 인라인 HTML이 같은 기준을 쓴다). 사람이 못 보는 글은 표시 본문에 넣지 않는다."""
from __future__ import annotations

import re

_I = re.IGNORECASE
_OFFSCREEN = re.compile(r"(?:^|;)\s*(?:left|top|margin-left|margin-top|text-indent)\s*:\s*-\s*\d{3,}", _I)
_HIDE_DECLS = (
    re.compile(r"display\s*:\s*none", _I),
    re.compile(r"visibility\s*:\s*(?:hidden|collapse)", _I),
    re.compile(r"(?:^|;)\s*font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%|vw|vh)?\s*(?:;|!|$)", _I),
    re.compile(r"(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|!|$)", _I),
    re.compile(r"clip\s*:\s*rect\(\s*0", _I),
    re.compile(r"clip-path\s*:\s*inset\(\s*(?:50|100)%", _I),
    _OFFSCREEN,
)
_WHITE = re.compile(r"(?:^|;)\s*color\s*:\s*(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0)?\s*)?\))\s*(?:;|!|$)", _I)
DROP_TAGS = frozenset({"script", "style", "noscript", "template", "head", "iframe", "object", "embed", "svg", "canvas"})


def style_hidden(style: str | None) -> bool:
    """인라인 스타일 또는 CSS 선언 묶음이 글을 감추는가. 흰 글씨는 배경 지정이 없을 때만 숨김으로 본다."""
    if not style:
        return False
    s = style.strip()
    if any(p.search(s) for p in _HIDE_DECLS):
        return True
    return bool(_WHITE.search(s)) and "background" not in s.lower()


def attrs_hidden(attrs) -> bool:
    """attrs: 이름(소문자) -> 값 매핑. hidden, aria-hidden=true, type=hidden, 숨김 스타일."""
    a = {str(k).lower(): ("" if v is None else str(v)) for k, v in dict(attrs).items()}
    if "hidden" in a and a["hidden"].lower() not in ("false", "no"):
        return True
    if a.get("aria-hidden", "").strip().lower() == "true":
        return True
    if a.get("type", "").strip().lower() == "hidden":
        return True
    return style_hidden(a.get("style"))


_RULE = re.compile(r"([^{}@]+)\{([^{}]*)\}")
_SIMPLE_SEL = re.compile(r"^[\w.#\-\s>*\[\]=\"']+$")


def hidden_selectors(css_texts) -> list[str]:
    """<style> 본문에서 숨김 선언을 가진 단순 선택자만 뽑는다. 가상 클래스와 @규칙은 건너뛴다."""
    out: list[str] = []
    for css in css_texts:
        css = re.sub(r"/\*.*?\*/", "", css or "", flags=re.S)
        for sel, decl in _RULE.findall(css):
            if not style_hidden(decl):
                continue
            for one in sel.split(","):
                one = one.strip()
                if one and _SIMPLE_SEL.match(one):
                    out.append(one)
    return out
