import re

import pytest

from kb import ticket
from kb.intake import core, urls


def test_normalize_and_dedupe():
    n = urls.normalize
    assert n("https://Example.ORG:443/a?utm_source=x&id=1&fbclid=z#frag") == "https://example.org/a?id=1"
    assert n("https://example.org") == "https://example.org/"
    assert n("http://example.org/a") is None
    assert urls.extract("보라 (https://a.org/x). 또 https://a.org/x, [l](https://b.org/y)") == \
        ["https://a.org/x", "https://a.org/x", "https://b.org/y"]


@pytest.mark.parametrize("u,why", [
    ("https://10.x.x.x/a", "ip_literal"), ("https://[::1]/a", "ip_literal"), ("https://intranet/a", "no_dot_host"),
    ("https://nas.lan/a", "internal_suffix"), ("https://x.home.arpa/a", "internal_suffix"),
    ("https://user:pw@example.org/a", "userinfo"), ("https://example.org/a?access_token=1", "secret_query"),
    ("https://example.org/a?SIG=1", "secret_query"), ("https://example.org/a?api_key=1", "secret_query"),
    ("https://example.org/a", None)])
def test_skip_reason(u, why):
    n = urls.normalize(u)
    assert urls.skip_reason(n) == why


def test_deny_string_in_url_is_skipped():
    assert urls.skip_reason("https://example.org/zz-node-alpha", re.compile("zz-node-alpha", re.I)) == "deny_string"


def open_urls():
    return {u for r in ticket._open_rows() for u in r["urls"]}


def test_register_dedupe_denied_active_and_idempotent(sample, monkeypatch):
    man, _ = sample
    import kb.collect as kc
    real = kc.host_allowed
    monkeypatch.setattr(kc, "host_allowed", lambda h: False if h == "example.net" else real(h))
    monkeypatch.setattr(core, "_active_urls", lambda: {"https://example.org/docs/a?id=7"})
    r = core.run(man)
    # 후보: docs/a(활성 소스라 건너뜀), net/t(거부), pub1(전사 파일 중복 1건 제거, 사설/내부는 본문 정화에서 빠짐), pub2
    assert r["urls"]["denied"] == 1
    assert r["urls"]["registered"] == 2 and open_urls() == {"https://example.org/pub1", "https://example.org/pub2"}
    assert r["urls"]["extracted"] == r["urls"]["registered"] + r["urls"]["skipped"] + r["urls"]["denied"]
    assert r["tickets"] >= 1
    r2 = core.run(man)
    assert r2["new_events"] == 0 and r2["urls"] == r["urls"] and open_urls() == {"https://example.org/pub1", "https://example.org/pub2"}


def test_urls_accumulate_in_one_ticket_per_topic(sample):
    man, _ = sample
    man["items"] = [i for i in man["items"] if i["id"] in ("i-urls", "i-ex")]
    man["items"][0]["urls_file"] = man["items"][0]["urls_file"]
    core.run(man)
    rows = ticket._open_rows()
    assert len(rows) == 1 and rows[0]["topic"].startswith("세션 출처 재확인: ")
    assert rows[0]["urls"] == ["https://example.org/pub1"]


def test_no_urls_flag_skips_candidates(sample):
    man, _ = sample
    for i in man["items"]:
        i["no_urls"] = True
    r = core.run(man)
    assert r["urls"] == {"extracted": 0, "registered": 0, "skipped": 0, "denied": 0} and r["tickets"] == 0


def test_cap_is_counted_not_silent(sample, monkeypatch):
    man, _ = sample
    monkeypatch.setattr(ticket, "MAX_URLS", 1)
    r = core.run(man)
    assert r["ticket_capped"] >= 1 and r["urls"]["registered"] + r["ticket_capped"] <= r["urls"]["extracted"]


def test_cli_output_matches_schema(sample, tmp_path, capsys):
    import json
    import jsonschema
    import yaml
    from pathlib import Path
    from kb.cli import main
    man, _ = sample
    mp = tmp_path / "m.yaml"
    mp.write_text(yaml.safe_dump(man, allow_unicode=True))
    schema = json.loads((Path(__file__).resolve().parents[2] / "schemas/cli/intake.schema.json").read_text())
    for act in ("plan", "run", "run", "status"):
        assert main(["intake", act, "--json", "--manifest", str(mp)]) == 0
        out = json.loads(capsys.readouterr().out)
        jsonschema.validate(out, schema)
    assert out["unresolved"] == 0 and out["excluded"] >= 1 and out["new_events"] == 0
    assert out["stored"] + out["held"] + out["excluded"] == out["items"]
