"""없는 CAS 객체: 일반 재구축은 치명 오류, --allow-missing은 끝까지 가고 목록을 낸다."""
import json

import pytest

from kb.commands import rebuild as cmd
from kb.core import ledger
from kb.project import MissingObject, current_build, current_gold_path, gold_root, rebuild
from projhelp import E, entity, snap_events


def _setup(led):
    evs = snap_events()
    gone = evs[1]["payload"]["paras_sha"]
    from kb.core import cas
    cas.delete(gone)
    ledger.append(led, [entity("e:tool:x"), *evs, entity("e:tool:y")])
    return gone


def test_plain_rebuild_fails_and_leaves_no_trace(led, kb_home):
    gone = _setup(led)
    with pytest.raises(MissingObject) as ei:
        rebuild(led=led)
    assert gone in ei.value.shas
    assert current_build() is None
    assert not [d for d in gold_root().iterdir()]


def test_allow_missing_goes_to_the_end(led, kb_home):
    gone = _setup(led)
    r = rebuild(allow_missing=True, led=led)
    assert r.swapped and r.missing == [gone]
    from kb.project import open_gold
    g = open_gold(current_gold_path())
    assert {x[0] for x in g.execute("SELECT id FROM node WHERE type='Tool'")} == {"e:tool:x", "e:tool:y"}
    g.close()


def test_cli_records_gap_and_recapture(led, kb_home, monkeypatch, capsys):
    gone = _setup(led)
    led.close()
    from kb.cli import main
    assert main(["rebuild", "gold", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["code"] == "cas_missing"
    assert main(["rebuild", "gold", "--allow-missing", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["missing"] == [gone] and out["gaps"] == 1 and out["queued"] == 1
    c = ledger.open_ledger()
    gaps = [e for e in ledger.iter_events(c, 0, 100) if e["kind"] == "gap.recorded"]
    assert gaps and gaps[0]["payload"]["source"] == "src:a" and gone in gaps[0]["payload"]["reason"]
    c.close()
