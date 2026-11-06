"""정확한 링크 모양은 편집기 경로에만 적용한다."""
import pytest

from kb.write import record
from test_write_core import REC, core, payload, put

VALID = ["f-" + "a" * 26, "e:feature:youtube-shorts", "c-" + "a" * 12,
         "r-" + "b" * 12, "ev-" + "c" * 12, "n-" + "0" * 16, "d-" + "f" * 16]
INVALID = ["Shorts", "쇼츠 후킹 구조", "c-suite", "d-day", "s-session", "f-" + "a" * 25,
           "f-" + "A" * 26, "c-" + "a" * 11, "n-" + "g" * 16, "e:feature:"]


@pytest.mark.parametrize("target", VALID)
def test_editor_exact_wikilink_shape_and_dedup(core, target):
    result = put(dict(REC, body=f"[[{target}|이름]] [[{target}#제목]]",
                      links=[{"rtype": "LINKS_TO", "dst": target}]))
    assert payload(result.id)["links"] == [{"rtype": "LINKS_TO", "dst": target}]
    assert any(w.startswith("link_dangling:") for w in result.warnings)
    assert all(target not in w and "이름" not in w for w in result.warnings)


@pytest.mark.parametrize("target", INVALID)
def test_editor_invalid_wikilink_shape_warns_by_ordinal(core, target):
    result = put(dict(REC, body=f"[[{target}]]"))
    assert payload(result.id).get("links", []) == []
    assert len(result.warnings) == 1
    prefix, ordinal = result.warnings[0].split(":", 1)
    assert prefix == "link_not_id" and ordinal.isdecimal()
    assert target not in result.warnings[0]


@pytest.mark.parametrize("transport", ["mcp", "inbox", "cli"])
def test_legacy_wikilink_shape_stays_broad(core, transport):
    result = record.put_record(dict(REC, body="[[Shorts]] [[c-suite]]"), "fw3:legacy-links", transport, "fw3", tty=True)
    assert payload(result.id)["links"] == [{"rtype": "LINKS_TO", "dst": "Shorts"},
                                            {"rtype": "LINKS_TO", "dst": "c-suite"}]
