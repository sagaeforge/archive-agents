"""FW9 RED: unresolved intent only, deduplication and automatic closure."""
import pytest

from test_publish_async import FW9, api, core, kb_home, data  # noqa: F401

KINDS = ['topic_ambiguity', 'source_policy', 'liveness_unresolved', 'gate_unresolved']


@pytest.mark.parametrize('kind', KINDS)
def test_unresolved_signal_creates_one_item_per_target_verdict_and_auto_closes(api, monkeypatch, kind):
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    fw.signal(kind, resolved=True)
    assert fw.hitl() == []
    first = fw.signal(kind)
    second = fw.signal(kind)
    assert first['id'] == second['id']
    items = fw.hitl()
    assert len(items) == 1
    item = items[0]
    assert item['kind'] == kind and item['target'] == fw.target
    assert item['reason'] and item['attempted'] == ['automatic']
    assert {'candidates', 'evidence', 'proposed_state', 'created_at'} <= item.keys()
    fw.signal(kind, resolved=True)
    assert fw.hitl() == []
    assert fw.actions.get_hitl(first['id'])['state'] == 'auto_resolved'
    third = fw.signal(kind, verdict=2)
    assert third['id'] != first['id'] and len(fw.hitl()) == 1


@pytest.mark.parametrize('case', ['ordinary_research', 'clear_topic', 'automatic_source',
                                  'supported_entailment', 'dead', 'superseded', 'removed'])
def test_ordinary_results_and_conclusive_states_do_not_create_hitl(api, monkeypatch, case):
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    fw.actions.reconcile_hitl(dict(kind=case, target=fw.target, verdict=1, unresolved=False,
                                   reason='automatic outcome', attempted=['automatic']))
    assert fw.hitl() == []


@pytest.mark.parametrize('decision,expected', [('accept', 'user_accepted'), ('reject', 'user_rejected')])
def test_gate_resolution_changes_only_review_state_not_claim_evidence(api, monkeypatch, decision, expected):
    from read.rhelp import claim, entity, snap
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    api.world.add(snap(), entity('e:tool:fw9'),
                  claim('c-fw9', 'e:tool:fw9', '합성 인용 문장', verification='needs_review'))
    def get_claim():
        response = api.call('GET', '/v1/claims/c-fw9', fw.token)
        assert response.status == 200
        return data(response)['data']
    original = get_claim()
    item = fw.signal(target='c-fw9')['id']
    response = api.call('POST', '/v1/hitl/challenge', fw.token, dict(item=item, action=decision, params={}))
    assert response.status == 201
    challenge = data(response)
    response = api.call('POST', f'/v1/hitl/{item}/resolve', fw.token,
                        dict(action=decision, params={}, challenge_id=challenge['challenge_id'],
                             assertion=fw.auth.sign(challenge), idempotency_key='fw9-review:h:gate'))
    assert response.status == 200, response.body
    current = get_claim()
    assert current['review_state'] == expected
    for field in ('statement', 'evidence', 'verification'):
        assert current[field] == original[field]
    assert current['verification'] == 'needs_review'
    assert fw.hitl() == []


def test_signal_target_and_kind_have_separate_dedup_namespaces(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    ids = {fw.signal(kind=kind, target=target)['id']
           for kind in KINDS for target in (fw.target, 'e:tool:other')}
    assert len(ids) == 8
