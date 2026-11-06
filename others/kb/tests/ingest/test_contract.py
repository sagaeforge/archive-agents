"""계약 오류(머리 줄, contract 값, JSON 파싱 실패, 상한)는 exit 2이고 아무것도 쓰지 않는다. 결과 코드와 exit 0/1."""
import json

import pytest

from kb import ingest
from kb.cli import main

from .conftest import FX, bundle, event_count, run, seed_snapshots, write_jsonl


def test_bad_header_fixture_exit_2_and_nothing_written(env, capsys):
    before = event_count()
    rc = main(["ingest", "validate", str(FX / "bad_header.jsonl"), "--no-fetch"])
    assert rc == 2 and "계약 오류" in capsys.readouterr().err
    rc = main(["ingest", "submit", str(FX / "bad_header.jsonl"), "--no-fetch"])
    assert rc == 2 and event_count() == before


def test_missing_header_and_json_garbage(env, tmp_path):
    p = write_jsonl(tmp_path / "a.jsonl", [{"item": "snapshot", "ref": "s1"}])
    assert main(["ingest", "validate", str(p), "--no-fetch"]) == 2
    q = tmp_path / "b.jsonl"
    q.write_text(json.dumps(bundle([])[0]) + "\n{not json\n")
    assert main(["ingest", "validate", str(q), "--no-fetch"]) == 2


def test_bundle_and_call_limits():
    objs = bundle([{"item": "entity", "key": f"concept:c{i}", "type": "Concept", "label": f"c{i}"} for i in range(5001)])
    with pytest.raises(ingest.ContractError):
        ingest.from_objects(objs)
    with pytest.raises(ingest.ContractError):
        ingest.check_call_limit(objs[:102])          # 머리 + 항목 101개
    ingest.check_call_limit(objs[:101])             # 머리 + 항목 100개는 허용


def test_exit_codes_and_summary(env, capsys, tmp_path):
    ok = write_jsonl(tmp_path / "ok.jsonl", bundle([{"item": "entity", "key": "concept:okay", "type": "Concept", "label": "okay"}]))
    assert main(["ingest", "validate", str(ok), "--no-fetch", "--json"]) == 0
    last = capsys.readouterr().out.strip().splitlines()[-1]
    assert json.loads(last)["summary"]["accepted"] == 1
    bad = write_jsonl(tmp_path / "bad.jsonl", bundle([{"item": "entity", "key": "concept:okay", "label": "x"}]))
    assert main(["ingest", "validate", str(bad), "--no-fetch"]) == 1


def test_schema_and_ref_errors(env):
    rep = run([{"item": "claim", "ref": "c1", "subject": "e:nope:x", "statement": "x", "kind": "state", "stance": "stated",
                "evidence": {"snapshot": "zz", "quote": "abcdefgh"}, "method": "llm"},
               {"item": "claim", "ref": "c2", "subject": "e:nope:x", "kind": "state"},
               {"item": "banana"}])
    assert [r["code"] for r in rep.lines] == ["E_REF", "E_SCHEMA", "E_SCHEMA"]


def test_first_batch_validates_clean_with_one_held(env, capsys):
    seed_snapshots()
    rc = main(["ingest", "validate", str(FX / "first_batch.jsonl"), "--no-fetch", "--json"])
    out = [json.loads(x) for x in capsys.readouterr().out.strip().splitlines()]
    s = out[-1]["summary"]
    assert rc == 0 and s["rejected"] == 0 and s["held"] >= 1, out
    kinds = {r.get("ref") for r in out[:-1]}
    assert {"s1", "s2", "s3", "e0", "e1", "e2", "c1", "c2", "c3", "l1", "r1"} <= kinds
