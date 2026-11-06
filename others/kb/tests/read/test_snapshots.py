"""스냅샷 읽기: 메타데이터, 표시 본문 창, 원본(Range), 삭제 시 ContentRemoved(410)."""
import pytest

from kb import read
from kb.core import cas
from .rhelp import E, claim, entity, snap


def _world(w):
    raw = cas.put("<html>원본 바이트</html>".encode())
    w.add(E("source.registered", {"id": "src:a", "label": "출처A"}, "src:a"), entity("e:tool:x", "X"),
          snap(source="src:a", raw=raw, paras=("가나다라마바사", "아자차카타파하")), claim("c-1", "e:tool:x", "가나다라마바사"))
    return raw


def test_meta_text_window_and_raw(w):
    raw = _world(w)
    with w.rd() as (con, c):
        m = read.snapshot_meta(con, c, "n-1")
        assert m["url"] == "https://a.example/doc" and m["source"]["label"] == "출처A" and m["raw_sha256"] == raw
        assert m["text_chars"] == len("가나다라마바사\n\n아자차카타파하") and m["text_format"] == "text" and m["http_status"] == 200
        assert [x["id"] for x in m["citing_claims"]] == ["c-1"]
        t = read.snapshot_text(con, c, "n-1", start=2, max_chars=5)
        assert t == {"text": "다라마바사", "start": 2, "end": 7, "total_chars": m["text_chars"], "text_format": "text"}
        assert read.snapshot_text(con, c, "n-1")["end"] == m["text_chars"]
        with pytest.raises(read.LimitTooLarge):
            read.snapshot_text(con, c, "n-1", max_chars=200_001)
        body, hdr, st = read.snapshot_raw(con, c, "n-1")
        assert st == 200 and body == "<html>원본 바이트</html>".encode() and hdr["X-Content-Type-Options"] == "nosniff"
        assert hdr["Content-Disposition"] == 'attachment; filename="n-1"' and hdr["Content-Type"] == "text/plain"
        part, h2, st2 = read.snapshot_raw(con, c, "n-1", range_header="bytes=0-5")
        assert st2 == 206 and part == body[:6] and h2["Content-Range"] == f"bytes 0-5/{len(body)}"
        assert read.snapshot_raw(con, c, "n-1", range_header="bytes=-3")[0] == body[-3:]
        with pytest.raises(read.ReadError) as e:
            read.snapshot_raw(con, c, "n-1", range_header="bytes=9999-")
        assert e.value.status == 416
        for bad in ("e:tool:x", "c-1", "n-none"):
            with pytest.raises(read.NotFound):
                read.snapshot_meta(con, c, bad)


def test_as_of_is_400_and_removed_content_is_410(w):
    raw = _world(w)
    with w.rd(as_of_observed=1) as (con, c):
        for fn in (read.snapshot_meta, read.snapshot_text, read.snapshot_raw):
            with pytest.raises(read.AsOfUnsupported):
                fn(con, c, "n-1")
    with w.rd() as (con, c):
        sha = read.snapshot_meta(con, c, "n-1")["text_sha256"]
    cas.delete(sha)
    cas.delete(raw)
    with w.rd() as (con, c):
        with pytest.raises(read.ContentRemoved):
            read.snapshot_text(con, c, "n-1")
        with pytest.raises(read.ContentRemoved):
            read.snapshot_raw(con, c, "n-1")
        assert read.snapshot_meta(con, c, "n-1")["id"] == "n-1"  # 메타데이터는 계속 읽힌다
