"""숨김 본문 9종과 Markdown 인라인 숨김이 표시 본문에 없다."""
from kb.parse.display import display_text, markdown_display

VISIBLE = [f"보이는 문장 {i}번은 사용자에게 그대로 보이는 본문이며 길이를 충분히 확보하기 위해 조금 길게 쓴다." for i in range(1, 7)]

HTML = """<!doctype html><html><head><title>시험 페이지</title>
<style>.sr-only{display:none} .tiny{font-size:0} #ghost{visibility:hidden}</style></head>
<body><main><article><h1>시험 문서</h1>
<p>%(v1)s</p>
<p hidden>HIDDEN_ATTR 숨김 속성 문장</p>
<p style="font-size:0">FONT_ZERO 글자 크기 0 문장</p>
<p style="color:#fff">WHITE_TEXT 흰 글씨 문장</p>
<p style="position:absolute;left:-9999px">OFFSCREEN 화면 밖 배치 문장</p>
<p class="sr-only">CSS_CLASS 클래스 숨김 문장</p>
<p>%(v2)s</p>
<p style="display:none">DISPLAY_NONE 표시 없음 문장</p>
<p aria-hidden="true">ARIA_HIDDEN 보조기기 숨김 문장</p>
<!-- HTML_COMMENT 주석 문장 -->
<noscript>NOSCRIPT 스크립트 없음 문장</noscript>
<p>%(v3)s</p><p>%(v4)s</p><p>%(v5)s</p><p>%(v6)s</p>
<p style="color:#fff;background:#000">WHITE_ON_BLACK 배경이 있는 흰 글씨는 보인다</p>
</article></main></body></html>""" % {f"v{i}": VISIBLE[i - 1] for i in range(1, 7)}

HIDDEN = ["HIDDEN_ATTR", "FONT_ZERO", "WHITE_TEXT", "OFFSCREEN", "CSS_CLASS", "DISPLAY_NONE", "ARIA_HIDDEN", "HTML_COMMENT", "NOSCRIPT"]


def test_html_nine_hidden_kinds_removed():
    t = display_text(HTML.encode(), "text/html; charset=utf-8")
    assert t.fmt == "markdown"
    for h in HIDDEN:
        assert h not in t.text, h
    for v in VISIBLE:
        assert v in t.text
    assert "WHITE_ON_BLACK" in t.text       # 배경이 있는 흰 글씨는 사람이 읽는다


def test_html_visibility_hidden_by_id_rule():
    html = ("<html><body><style>#ghost{visibility:hidden}</style><article>" + "".join(f"<p>{v}</p>" for v in VISIBLE) +
            '<p id="ghost">GHOST_ID 숨김</p></article></body></html>')
    assert "GHOST_ID" not in display_text(html.encode(), "text/html").text


MD = """# 제목

보이는 문단이다.

<!-- MD_COMMENT 주석
여러 줄 주석 -->

보이는 문단 둘. <span style="display:none">MD_INLINE_HIDDEN</span> 뒤 글.

<div hidden>
MD_DIV_HIDDEN 블록
</div>

<p aria-hidden="true">MD_ARIA</p>

<span style="color:white">MD_WHITE</span>

```html
<!-- 코드 안의 주석은 남는다 -->
<span style="display:none">코드 안의 숨김 태그도 남는다</span>
```

<details><summary>펼침</summary>보이는 펼침 내용</details>
"""


def test_markdown_inline_html_hidden_removed():
    t = markdown_display(MD.encode())
    assert t.fmt == "markdown" and t.extractor == "passthrough-nfc@1"
    for h in ("MD_COMMENT", "MD_INLINE_HIDDEN", "MD_DIV_HIDDEN", "MD_ARIA", "MD_WHITE"):
        assert h not in t.text, h
    assert "보이는 문단 둘." in t.text and "뒤 글." in t.text
    assert "코드 안의 주석은 남는다" in t.text and "코드 안의 숨김 태그도 남는다" in t.text
    assert "보이는 펼침 내용" in t.text


def test_markdown_is_nfc_and_stable():
    import unicodedata
    s = "가" if False else unicodedata.normalize("NFD", "한글 문서\n")
    t = markdown_display(s.encode())
    assert t.text == unicodedata.normalize("NFC", s)
    assert markdown_display(s.encode()).text == t.text
