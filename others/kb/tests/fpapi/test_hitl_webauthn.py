"""FW9 RED: proof/state binding, atomic consumption and manual bypass."""
from types import SimpleNamespace

import pytest

from test_publish_async import FW9, api, core, kb_home, data, problem  # noqa: F401


@pytest.mark.parametrize('fault', ['missing', 'signature', 'uv', 'counter_zero', 'unknown_credential', 'challenge'])
def test_invalid_proof_has_no_ledger_change(api, monkeypatch, fault):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    changes = {'uv': {'uv': False}, 'counter_zero': {'counter': 0},
               'unknown_credential': {'credential_id': 'not-installed'}}
    assertion = fw.auth.sign(dict(challenge, challenge='not-issued') if fault == 'challenge' else challenge,
                             **changes.get(fault, {}))
    if fault == 'signature':
        assertion['signature'] = '00' * 32
    before = fw.head()
    response = fw.execute(aid, None if fault == 'missing' else challenge, assertion=assertion)
    problem(response, 403, 'review_unverified')
    assert fw.head() == before


@pytest.mark.parametrize('age,accepted', [(119, True), (120, False), (121, False)])
def test_challenge_ttl_exactly_120_seconds(api, monkeypatch, age, accepted):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    fw.now += age
    before = fw.head()
    response = fw.execute(aid, challenge)
    if accepted:
        assert response.status == 200
    else:
        problem(response, 403, 'review_unverified')
        assert fw.head() == before


def test_single_use_challenge_and_execution_replay_do_not_duplicate_events(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    first = fw.execute(aid, challenge)
    assert first.status == 200
    before = fw.head()
    replay = fw.execute(aid, challenge)
    assert replay.status == 200 and data(replay)['result'] == data(first)['result']
    assert fw.head() == before
    # New action, same target version, but consumed proof from another action.
    prepared = fw.prepare(key='fw9-review:a:new')
    assert prepared.status == 202
    second = data(prepared)['action_id']
    fw.drain()
    before = fw.head()
    problem(fw.execute(second, challenge, key='fw9-review:a:new-exec'), 403, 'review_unverified')
    assert fw.head() == before


@pytest.mark.parametrize('counter', [0, 1])
def test_counter_must_strictly_increase_across_distinct_actions(api, monkeypatch, counter):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    assert fw.execute(aid, fw.challenge(aid)).status == 200
    response = fw.prepare(key='fw9-review:a:second')
    assert response.status == 202
    second = data(response)['action_id']
    fw.drain()
    challenge = fw.challenge(second)
    before = fw.head()
    problem(fw.execute(second, challenge, assertion=fw.auth.sign(challenge, counter=counter),
                       key='fw9-review:a:second-exec'), 403, 'review_unverified')
    assert fw.head() == before


@pytest.mark.parametrize('change', ['version', 'state', 'candidate_body', 'candidate_type', 'candidate_sensitivity'])
def test_target_or_result_changed_is_stale_without_ledger_change(api, monkeypatch, change):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    if change == 'version':
        fw.change_source(body='새로운 판')
    elif change == 'state':
        fw.change_source(props={'review_state': 'user_rejected'})
    else:
        # Proposed persistence port mutates saved candidate, not the adapter's old copy.
        values = {'candidate_body': {'body': '변경 결과'}, 'candidate_type': {'type': 'Page'},
                  'candidate_sensitivity': {'sensitivity': 'public'}}
        fw.actions.update_candidate(aid, 0, **values[change])
    before = fw.head()
    problem(fw.execute(aid, challenge), 409, 'review_stale')
    assert fw.head() == before


def test_changing_hitl_action_after_challenge_is_unverified(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    item = fw.signal()['id']
    response = api.call('POST', '/v1/hitl/challenge', fw.token, dict(item=item, action='accept', params={}))
    assert response.status == 201
    challenge = data(response)
    before = fw.head()
    response = api.call('POST', f'/v1/hitl/{item}/resolve', fw.token,
                        dict(action='reject', params={}, challenge_id=challenge['challenge_id'],
                             assertion=fw.auth.sign(challenge), idempotency_key='fw9-review:h:altered'))
    problem(response, 403, 'review_unverified')
    assert fw.head() == before


def test_tty_manual_review_does_not_bypass_webauthn(api, monkeypatch):
    from kb.commands import review
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    item = fw.signal(kind='liveness_unresolved')['id']
    monkeypatch.setattr('sys.stdin.isatty', lambda: True)
    before = fw.head()
    args = SimpleNamespace(id=item, liveness='alive', by='user', successor=None, keep=False, json=True)
    assert review._decide(args) == 2
    assert fw.head() == before and len(fw.hitl()) == 1


def test_tty_secret_release_does_not_bypass_webauthn(api, monkeypatch):
    from kb.commands.secret import cmd_secret
    fw = FW9(api, monkeypatch)
    fw.change_source(props={'quarantine': True})
    monkeypatch.setattr('sys.stdin.isatty', lambda: True)
    before = fw.head()
    assert cmd_secret(SimpleNamespace(action='release', target=fw.target, json=True)) != 0
    assert fw.head() == before


def test_hitl_verdict_changed_since_challenge_is_stale(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.hitl()  # Require the public HITL route before the pure signal port.
    import kb.write.actions  # noqa: F401 - this test needs the pure signal port
    item = fw.signal(kind='liveness_unresolved')['id']
    response = api.call('POST', '/v1/hitl/challenge', fw.token,
                        dict(item=item, action='confirm', params={}))
    assert response.status == 201
    challenge = data(response)
    fw.signal(kind='liveness_unresolved', verdict=2)
    before = fw.head()
    response = api.call('POST', f'/v1/hitl/{item}/resolve', fw.token,
                        dict(action='confirm', params={}, challenge_id=challenge['challenge_id'],
                             assertion=fw.auth.sign(challenge), idempotency_key='fw9-review:h:stale'))
    problem(response, 409, 'review_stale')
    assert fw.head() == before
