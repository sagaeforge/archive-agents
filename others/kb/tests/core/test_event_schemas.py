import json
import re
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")
referencing = pytest.importorskip("referencing")

from kb.core import ledger, paths, upcast
from kb.core.canon import canon_json

SD = paths.share_dir() / "schemas" / "events"
SHA = "a" * 64
ADR_KINDS = ("record.put record.tombstone record.redact entity.put entity.alias entity.merge edge.put edge.expire "
             "claim.assert claim.confirm claim.supersede claim.withdraw claim.retract claim.review snapshot.captured "
             "snapshot.text series.define series.batch source.registered source.status gap.recorded survival.verdict "
             "extract.run extract.rejected ticket.open ticket.update ticket.close schema.type_defined "
             "schema.predicate_defined schema.epoch_bumped system.fp_opened system.projection_quarantined "
             "system.projection_released").split()

EVID = {"snapshot": "n-1", "selector_kind": "text_quote", "exact": "q"}
GOOD = {
    "record.put": {"id": "f-1", "type": "Note", "title": "t", "body": "b", "sensitivity": "internal"},
    "record.tombstone": {"id": "f-1", "reason": "r"},
    "record.redact": {"id": "f-1", "reason": "r", "payload_shas": [SHA]},
    "entity.put": {"id": "e:tool:x", "type": "Tool", "label": "x", "domain": ["G"]},
    "entity.alias": {"id": "e:tool:x", "alias": "엑스"},
    "entity.merge": {"from": "e:tool:x", "into": "e:tool:y"},
    "edge.put": {"id": "r-1", "src": "e:a:b", "rtype": "USES", "dst": "e:a:c"},
    "edge.expire": {"id": "r-1"},
    "claim.assert": {"id": "c-1", "subject": "e:a:b", "predicate": "removed_in", "value": "2.1.222", "statement": "s",
                     "kind": "event", "stance": "stated", "method": "llm", "verification": "quote_found", "evidence": [EVID]},
    "claim.confirm": {"id": "c-1", "snapshot": "n-1"},
    "claim.supersede": {"id": "c-1", "by": "c-2"},
    "claim.withdraw": {"id": "c-1", "reason": "r"},
    "claim.retract": {"id": "c-1", "reason": "r"},
    "claim.review": {"id": "c-1", "verification": "quote_found", "decided_by": "gate:1"},
    "snapshot.captured": {"id": "n-1", "document_id": "d-1", "source": "src:a", "url": "https://a.b/", "raw_sha": SHA, "fetched_at": 1},
    "snapshot.text": {"snapshot": "n-1", "text_sha": SHA, "text_format": "markdown", "extractor": "passthrough-nfc@1", "paras_sha": SHA},
    "series.define": {"id": "s:x", "label": "x", "metric": "rank"},
    "series.batch": {"series_id": "s:x", "snapshot": "n-1", "parser": "p@1", "points_sha": SHA, "count": 3},
    "source.registered": {"id": "src:a"},
    "source.status": {"id": "src:a", "state": "failed"},
    "gap.recorded": {"source": "src:a", "from_at": 1, "to_at": 2, "reason": "offline"},
    "survival.verdict": {"target": "e:repo:x", "unit": "repo", "liveness": "removed", "status": "dead",
                         "signals": [{"id": "M05", "snapshot": "n-1", "quote": "Final"}], "decided_by": "agent:c"},
    "extract.run": {"window_sha": SHA, "para_shas": [SHA], "prompt_version": "1", "model": "haiku", "output_sha": SHA},
    "extract.rejected": {"window_sha": SHA, "code": "R_VALUE_MISMATCH"},
    "ticket.open": {"id": "t-1", "topic": "t", "reason": "r"},
    "ticket.update": {"id": "t-1", "status": "in_progress"},
    "ticket.close": {"id": "t-1", "status": "done"},
    "schema.type_defined": {"name": "Tool", "kind": "node", "version": 1, "status": "active"},
    "schema.predicate_defined": {"id": "removed_in", "functional": False, "value_kind": "version"},
    "schema.epoch_bumped": {"reason": "restore"},
    "system.fp_opened": {"mode": "drill"},
    "system.projection_quarantined": {"seq": 5, "error": "boom"},
    "system.projection_released": {"seq": 5},
}
BAD = {  # 위반 표본: 한 곳씩 깨뜨린다
    "record.put": {"id": "f-1", "type": "Note", "title": "t", "sensitivity": "internal"},  # body 없음
    "record.tombstone": {"id": "f-1"},
    "record.redact": {"id": "f-1", "reason": "r", "payload_shas": ["zz"]},
    "entity.put": {"id": "e:tool:x", "type": "Tool", "label": "x", "domain": ["Z"]},
    "entity.alias": {"id": "e:tool:x"},
    "entity.merge": {"from": "e:tool:x"},
    "edge.put": {"id": "r-1", "src": "e:a:b", "rtype": "USES"},
    "edge.expire": {},
    "claim.assert": {**GOOD["claim.assert"], "kind": "opinion"},
    "claim.confirm": {"id": "c-1"},
    "claim.supersede": {"id": "c-1"},
    "claim.withdraw": {"id": "c-1"},
    "claim.retract": {"reason": "r"},
    "claim.review": {"id": "c-1", "verification": "true", "decided_by": "g"},
    "snapshot.captured": {"id": "n-1", "document_id": "d-1", "source": "s", "url": "u", "raw_sha": "abc", "fetched_at": 1},
    "snapshot.text": {**GOOD["snapshot.text"], "text_format": "html"},
    "series.define": {"id": "s:x", "label": "x"},
    "series.batch": {**GOOD["series.batch"], "count": -1},
    "source.registered": {},
    "source.status": {"id": "src:a"},
    "gap.recorded": {"source": "src:a", "from_at": "1", "to_at": 2, "reason": "r"},
    "survival.verdict": {**GOOD["survival.verdict"], "liveness": "superseded"},  # successor 없음
    "extract.run": {"window_sha": SHA},
    "extract.rejected": {"code": "x"},
    "ticket.open": {"id": "t-1", "topic": "t"},
    "ticket.update": {"id": "t-1", "status": "weird"},
    "ticket.close": {"id": "t-1", "status": "queued"},
    "schema.type_defined": {"name": "Tool", "kind": "graph", "version": 1, "status": "active"},
    "schema.predicate_defined": {"id": "x", "functional": "yes", "value_kind": "v"},
    "schema.epoch_bumped": {},
    "system.fp_opened": {"mode": "force"},
    "system.projection_quarantined": {"seq": 0, "error": "e"},
    "system.projection_released": {"seq": "5"},
}


def _registry():
    from referencing import Registry, Resource
    reg = Registry()
    for p in SD.rglob("*.schema.json"):
        s = json.loads(p.read_text(encoding="utf-8"))
        reg = reg.with_resource(s["$id"], Resource.from_contents(s))
    return reg


def _validator(name, reg):
    s = json.loads((SD / f"{name}.schema.json").read_text(encoding="utf-8"))
    cls = jsonschema.validators.validator_for(s)
    cls.check_schema(s)
    return cls(s, registry=reg, format_checker=cls.FORMAT_CHECKER)


def test_every_adr_kind_has_schema_and_samples():
    assert set(ADR_KINDS) == set(ledger.KINDS) == set(GOOD) == set(BAD)
    for k in ADR_KINDS:
        assert (SD / f"{k}.schema.json").is_file(), k


@pytest.mark.parametrize("kind", ADR_KINDS)
def test_good_and_bad_samples(kind):
    reg = _registry()
    v = _validator(kind, reg)
    assert not list(v.iter_errors(GOOD[kind])), kind
    assert list(v.iter_errors(BAD[kind])), kind
    canon_json(GOOD[kind])  # 부동소수 없음


def test_attributed_claim_requires_speaker():
    v = _validator("claim.assert", _registry())
    c = {**GOOD["claim.assert"], "stance": "attributed"}
    assert list(v.iter_errors(c))
    assert not list(v.iter_errors({**c, "speaker": "OpenAI Docs"}))


def test_superseded_verdict_needs_successor():
    v = _validator("survival.verdict", _registry())
    ok = {**GOOD["survival.verdict"], "liveness": "superseded", "status": "superseded", "successor": "e:tool:y"}
    assert not list(v.iter_errors(ok))


def test_envelope():
    v = _validator("envelope", _registry())
    e = {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "idem_key": "k", "payload": {}}
    assert not list(v.iter_errors(e)) and list(v.iter_errors({**e, "kind": "x.y"}))


PARA = {"para_sha": SHA, "start_cp": 0, "end_cp": 10, "heading_path": ["A", "B"], "table_header": None}
POINT = {"period_key": "2026-10-30", "period_start": 1793318400000, "period_end": None, "value": "1", "unit": "rank"}


def test_object_shapes_fixed():
    reg = _registry()
    p = _validator("objects/para", reg) if False else None
    for name, good, mutations in (
        ("para", PARA, [{"start_cp": -1}, {"para_sha": "x"}, {"extra": 1}, {"heading_path": "A"}]),
        ("series_point", POINT, [{"value": "1.5e3"}, {"value": 1}, {"period_start": "x"}, {"extra": 1}]),
    ):
        s = json.loads((SD / "objects" / f"{name}.schema.json").read_text(encoding="utf-8"))
        v = jsonschema.Draft202012Validator(s, registry=reg)
        assert not list(v.iter_errors(good))
        for m in mutations:
            assert list(v.iter_errors({**good, **m})), (name, m)
        miss = {k: x for k, x in good.items() if k != next(iter(good))}
        assert list(v.iter_errors(miss))
    for name, good in (("paras", [PARA]), ("series_points", [POINT])):
        s = json.loads((SD / "objects" / f"{name}.schema.json").read_text(encoding="utf-8"))
        v = jsonschema.Draft202012Validator(s, registry=reg)
        assert not list(v.iter_errors(good)) and list(v.iter_errors([{"x": 1}]))


def test_predicates_yaml():
    yaml = pytest.importorskip("yaml")
    d = yaml.safe_load((paths.share_dir() / "schemas" / "predicates.yaml").read_text(encoding="utf-8"))
    ids = [p["id"] for p in d["predicates"]]
    assert len(ids) == len(set(ids)) and "removed_in" in ids
    for p in d["predicates"]:
        assert isinstance(p["functional"], bool) and p["value_kind"] and p["labels"]["ko"] and p["labels"]["en"]


def test_upcast_registry():
    assert upcast.current_v("claim.assert") == 1
    assert upcast.upcast("claim.assert", 1, {"a": 1}) == (1, {"a": 1})
    assert upcast.upcast("claim.assert", 1, None) == (1, None)
    with pytest.raises(ValueError):
        upcast.upcast("claim.assert", 2, {})
    @upcast.register("test.kind", 1)
    def _up(p):
        return {**p, "b": 2}
    try:
        assert upcast.current_v("test.kind") == 2
        assert upcast.upcast("test.kind", 1, {"a": 1}) == (2, {"a": 1, "b": 2})
    finally:
        upcast._REG.pop(("test.kind", 1))
