"""실제 주장 49건의 보류(needs_review 또는 거부). 표 머리와 절 제목을 문맥으로 쓰면 F7의 13건보다 줄어야 한다."""
from . import helpers as H


def test_real_claims_hold_at_most_13():
    rows = H.rows()
    assert len(rows) == 49
    held = [(i, r["statement"][:40]) for i, r in enumerate(rows) if not H.run(r).accepted]
    assert len(held) <= 13, held
    assert len(held) < 13, "표 머리 문맥으로 F7의 13건보다 줄어야 한다"


def test_table_rows_pass_through_table_header_and_section():
    rows = H.rows()
    quota = [r for r in rows if r["page"] == "quota" and r["quote"].startswith("|")]
    assert quota
    for r in quota:
        res = H.run(r)
        assert res.accepted, (r["statement"], res.detail)


def test_accepted_offsets_point_at_the_quote():
    d = H.docs()
    for r in H.rows():
        res = H.run(r)
        if res.accepted:
            assert d[r["page"]][res.start_cp:res.end_cp] == res.exact
            assert res.verification == "quote_found"
