"""문단 색인: 안정, 한 글자 변경은 해당 문단만, 표 행 문맥, NFC, 결정적, 오프셋."""
import json
import unicodedata

from kb.parse.paragraphs import MAX_CHARS, paragraphs, store

DOC = """# 제목

첫 문단이다. 두 번째 문장이다.

## 절 하나

둘째 문단.

셋째 문단.

## 절 둘

| 이름 | 값 |
|---|---|
| a | 1 |
| b | 2 |

끝 문단.
"""


def test_deterministic_and_offsets_slice_text():
    a, b = paragraphs(DOC), paragraphs(DOC)
    assert [p.as_dict() for p in a] == [p.as_dict() for p in b]
    for p in a:
        seg = DOC[p.start_cp:p.end_cp]
        assert seg == seg.strip() and seg
    assert [p.start_cp for p in a] == sorted(p.start_cp for p in a)


def test_one_char_change_changes_only_that_paragraph():
    a = paragraphs(DOC)
    b = paragraphs(DOC.replace("둘째 문단.", "둘째 문단!"))
    assert len(a) == len(b)
    diff = [i for i, (x, y) in enumerate(zip(a, b)) if x.para_sha != y.para_sha]
    assert len(diff) == 1 and DOC[a[diff[0]].start_cp:a[diff[0]].end_cp] == "둘째 문단."
    # 글자 수가 늘어도 다른 문단의 해시는 그대로다
    c = paragraphs(DOC.replace("둘째 문단.", "둘째 문단이 훨씬 더 길어졌다."))
    assert [p.para_sha for p in a if p.para_sha not in {q.para_sha for q in c}] == [a[diff[0]].para_sha]


def test_table_rows_carry_header_and_section_heading():
    ps = paragraphs(DOC)
    rows = [p for p in ps if p.table_header]
    assert [DOC[p.start_cp:p.end_cp] for p in rows] == ["| 이름 | 값 |", "| a | 1 |", "| b | 2 |"]
    for p in rows:
        assert p.table_header == ["이름", "값"] and p.heading_path == ["제목", "절 둘"]
    plain = [p for p in ps if DOC[p.start_cp:p.end_cp] == "셋째 문단."][0]
    assert plain.table_header is None and plain.heading_path == ["제목", "절 하나"]


def test_headings_split_paragraphs():
    ps = paragraphs("# A\n본문 바로 아래\n## B\n다음")
    assert [p.heading_path for p in ps] == [["A"], ["A"], ["A", "B"], ["A", "B"]]


def test_long_paragraph_splits_at_sentence_boundary():
    sent = "이것은 길이를 채우기 위한 문장이다. "
    text = sent * 60
    ps = paragraphs(text)
    assert len(ps) > 1 and all(p.end_cp - p.start_cp <= MAX_CHARS for p in ps)
    for p in ps[:-1]:
        assert text[p.start_cp:p.end_cp].endswith("다.")


def test_json_format_splits_on_lines():
    text = json.dumps({f"k{i}": "v" * 40 for i in range(40)}, indent=2, sort_keys=True) + "\n"
    ps = paragraphs(text, "json")
    assert len(ps) > 1 and all(p.end_cp - p.start_cp <= MAX_CHARS for p in ps)
    assert all(not text[p.start_cp:p.end_cp].startswith(" ") for p in ps)


def test_nfc_fixed_text_gives_same_hash():
    nfd = unicodedata.normalize("NFD", "한글 문단\n")
    from kb.parse.display import text_display
    t = text_display(nfd.encode()).text
    assert t == unicodedata.normalize("NFC", nfd)
    assert paragraphs(t)[0].para_sha == paragraphs(unicodedata.normalize("NFC", nfd))[0].para_sha


def test_store_writes_cas_object_matching_schema(kb_home):
    from kb.core import cas
    ps = paragraphs(DOC)
    sha = store(ps)
    data = json.loads(cas.get(sha))
    assert len(data) == len(ps) and set(data[0]) == {"para_sha", "start_cp", "end_cp", "heading_path", "table_header"}
    import jsonschema
    from pathlib import Path
    schema = json.loads((Path(__file__).resolve().parents[2] / "schemas/events/objects/para.schema.json").read_text())
    for d in data:
        jsonschema.validate(d, schema)
