"""골든 원장(NDJSON)을 새 원장에 재생한다. WP-02가 같은 파일로 gold 지문을 만든다."""
import json
from pathlib import Path

import pytest

from kb.core import ledger

GOLD = Path(__file__).resolve().parents[1] / "golden"


def load():
    return [json.loads(x) for x in (GOLD / "ledger.ndjson").read_text(encoding="utf-8").splitlines() if x]


def test_golden_replay_is_deterministic(led):
    evs = load()
    assert len(evs) >= 40 and {e["kind"] for e in evs} == set(ledger.KINDS)
    res = ledger.append(led, evs)
    assert len(res) == len(evs) and not any(r["replayed"] for r in res)
    assert ledger.verify_chain(led).ok
    seq, h = ledger.head(led)
    assert seq == len(evs)
    assert h == (GOLD / "ledger.head").read_text().strip(), "체인 형식이 바뀌었다. 이벤트 v를 올려야 하는지 확인"
    assert ledger.record_head(led, "f-golden1")[0] == 6
    assert ledger.record_head(led, "f-golden-r")[0] == 4
    assert [e["redacted"] for e in ledger.iter_events(led, 48, 10)] == [True, False, True, False]


def test_golden_payloads_validate():
    jsonschema = pytest.importorskip("jsonschema")
    from kb.core import paths
    from referencing import Registry, Resource
    sd = paths.share_dir() / "schemas" / "events"
    reg = Registry()
    for p in sd.rglob("*.schema.json"):
        s = json.loads(p.read_text(encoding="utf-8"))
        reg = reg.with_resource(s["$id"], Resource.from_contents(s))
    for e in load():
        s = json.loads((sd / f"{e['kind']}.schema.json").read_text(encoding="utf-8"))
        errs = list(jsonschema.Draft202012Validator(s, registry=reg).iter_errors(e["payload"]))
        assert not errs, (e["kind"], errs[:1])
