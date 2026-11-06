"""FW9 RED: two separate consents, exact bytes, no leakage or resend."""
import hashlib
import json

import pytest

from test_publish_async import FW9, api, core, kb_home, data, problem  # noqa: F401


def internal_puts(fw):
    return [e for e in fw.events() if e['kind'] == 'record.put' and e['payload'].get('sensitivity') == 'internal']


def test_reviewer_prepare_and_local_worker_make_zero_external_calls_or_publishes(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    before = internal_puts(fw)
    aid = fw.ready()
    assert fw.status(aid)['external_refine']['status'] == 'consent_required'
    assert fw.sent == [] and fw.reservations == [] and internal_puts(fw) == before
    problem(fw.execute(aid, action='external-refine'), 403, 'external_consent_required')
    assert fw.sent == [] and fw.reservations == []


@pytest.mark.parametrize('changed', ['memo_version', 'request_bytes', 'engine', 'model', 'expired_challenge', 'invalid_signature'])
def test_external_consent_binds_current_memo_actual_bytes_engine_model(api, monkeypatch, changed):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid, 'publish_external_refine')
    assertion = fw.auth.sign(challenge)
    if changed == 'memo_version':
        fw.change_source(body='전송 승인 뒤 변경')
    elif changed == 'request_bytes':
        fw.actions.update_external_plan(aid, request_bytes='다른 UTF-8 요청'.encode())
    elif changed in ('engine', 'model'):
        fw.actions.update_external_plan(aid, **{changed: 'different'})
    elif changed == 'expired_challenge':
        fw.now += 120
    else:
        assertion['signature'] = '00' * 32
    before = fw.head()
    stale = changed not in ('expired_challenge', 'invalid_signature')
    problem(fw.execute(aid, challenge, action='external-refine', assertion=assertion),
            409 if stale else 403, 'review_stale' if stale else 'review_unverified')
    fw.drain()
    assert fw.sent == [] and fw.reservations == [] and fw.head() == before


def test_first_consent_sends_exact_utf8_bytes_once_with_selected_engine_and_reports_cost(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    plan = fw.status(aid)['external_refine']
    challenge = fw.challenge(aid, 'publish_external_refine')
    response = fw.execute(aid, challenge, action='external-refine', key='fw9-review:a:consent')
    assert response.status == 202, response.body
    assert fw.status(aid)['refinement_mode'] == 'external_consented'
    assert fw.status(aid)['external_refine']['status'] == 'consented'
    fw.drain()
    assert len(fw.sent) == len(fw.reservations) == 1
    sent = fw.sent[0]
    assert isinstance(sent['body'], bytes)
    sent['body'].decode('utf-8')
    assert hashlib.sha256(sent['body']).hexdigest() == plan['external_payload_sha']
    assert (sent['engine'], sent['model'], sent['max_retries']) == ('fake', 'fake-model', 0)
    state = fw.status(aid)
    assert state['cost_usd'] == '0.0025' and state['duration_ms'] == 29
    assert state['engine'] == dict(kind='external', backend='fake', model='fake-model')
    assert internal_puts(fw) == []
    replay = fw.execute(aid, challenge, action='external-refine', key='fw9-review:a:consent')
    assert replay.status == 202
    fw.drain()
    assert len(fw.sent) == 1


@pytest.mark.parametrize('change', ['unsafe_trust', 'secret_source', 'source_version', 'payload', 'secret_payload'])
def test_worker_rechecks_immediately_before_reservation_and_send(api, monkeypatch, change):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid, 'publish_external_refine')
    response = fw.execute(aid, challenge, action='external-refine')
    assert response.status == 202
    def invalidate():
        if change == 'unsafe_trust':
            fw.fs.nodes['reviewers']['writable_uids'] = [1000]
        elif change == 'secret_source':
            fw.change_source(sensitivity='secret')
        elif change == 'source_version':
            fw.change_source(body='새로운 판')
        else:
            fw.actions.update_external_plan(aid, request_bytes=(
                b'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'
                if change == 'secret_payload' else b'changed request'))
    fw.before_send = invalidate
    fw.drain()
    assert fw.sent == [] and fw.reservations == [] and internal_puts(fw) == []


def test_uncertain_send_keeps_reservation_without_retry_or_engine_switch(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.external_error = TimeoutError('synthetic unknown delivery')
    aid = fw.ready()
    challenge = fw.challenge(aid, 'publish_external_refine')
    assert fw.execute(aid, challenge, action='external-refine').status == 202
    fw.drain()
    assert len(fw.sent) == 1 and fw.sent[0]['max_retries'] == 0
    assert fw.reservations[0]['state'] == 'uncertain'
    assert fw.status(aid)['state'] == 'failed'
    fw.selection.update(backend='fallback', model='fallback-model')
    fw.drain()
    assert len(fw.sent) == 1
    before = fw.head()
    problem(fw.execute(aid, challenge, action='external-refine', key='fw9-review:a:new-send'),
            403, 'review_unverified')
    assert fw.head() == before and len(fw.sent) == 1
    # A fresh local preparation is not consent to retry the uncertain send.
    assert fw.prepare(key='fw9-review:a:reprepare').status == 202
    fw.drain()
    assert len(fw.sent) == 1 and fw.reservations[0]['state'] == 'uncertain'


@pytest.mark.parametrize('direction', ['external_as_publish', 'publish_as_external'])
def test_two_confirmation_proofs_cannot_replace_each_other(api, monkeypatch, direction):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    first = direction == 'external_as_publish'
    challenge = fw.challenge(aid, 'publish_external_refine' if first else 'publish')
    before = fw.head()
    problem(fw.execute(aid, challenge, action='execute' if first else 'external-refine'), 403, 'review_unverified')
    fw.drain()
    assert fw.head() == before and fw.sent == [] and internal_puts(fw) == []


def test_external_refinement_invalidates_old_local_result_confirmation(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    local = fw.challenge(aid)
    consent = fw.challenge(aid, 'publish_external_refine')
    assert fw.execute(aid, consent, action='external-refine', key='fw9-review:a:external').status == 202
    fw.drain()
    before = fw.head()
    problem(fw.execute(aid, local, assertion=fw.auth.sign(local, counter=2)), 409, 'review_stale')
    assert fw.head() == before and internal_puts(fw) == []
    fresh = fw.challenge(aid)
    assert fw.execute(aid, fresh, assertion=fw.auth.sign(fresh, counter=2)).status == 200


@pytest.mark.parametrize('mode', ['simple', 'format', 'split', 'aliases', 'no_engine', 'no_budget', 'not_deployed'])
def test_simple_work_and_unavailable_paid_path_use_local_without_external_calls(api, monkeypatch, mode):
    fw = FW9(api, monkeypatch)
    if mode in ('simple', 'format', 'split', 'aliases'):
        fw.selection.update(kind='local', task=mode)
    elif mode == 'no_engine':
        fw.selection['available'] = False
    elif mode == 'no_budget':
        fw.selection['budget_available'] = False
    else:
        fw.selection['deployed'] = False
    state = fw.status(fw.ready())
    assert state['engine']['kind'] == 'local' and state['cost_usd'] == '0'
    assert state['external_refine']['status'] in ('not_needed', 'unavailable')
    assert fw.sent == [] and fw.reservations == []


def test_second_confirmation_publishes_only_internal_results_and_preserves_private_source(api, monkeypatch):
    from read.rhelp import record
    fw = FW9(api, monkeypatch)
    api.world.add(record('f-fw9-other', 'PRIVATE-OTHER-TITLE', 'private', body='PRIVATE-OTHER-BODY'))
    fw.change_source(body='정제할 합성 메모 [[f-fw9-other]]')
    response = api.call('POST', '/v1/actions', fw.token,
                        dict(action='publish', target=fw.target, expected_version=2,
                             idempotency_key='fw9-review:a:linked'))
    assert response.status == 202
    aid = data(response)['action_id']
    fw.drain()
    consent = fw.challenge(aid, 'publish_external_refine')
    assert fw.execute(aid, consent, action='external-refine', key='fw9-review:a:linked-consent').status == 202
    fw.drain()
    sent = b''.join(s['body'] for s in fw.sent)
    assert b'PRIVATE-OTHER-TITLE' not in sent and b'PRIVATE-OTHER-BODY' not in sent
    for call in fw.sent:
        extras = json.dumps({k: v for k, v in call.items() if k != 'body'}, ensure_ascii=False)
        assert '정제할 합성 메모' not in extras and 'PRIVATE-OTHER' not in extras
    assert internal_puts(fw) == []
    challenge = fw.challenge(aid)
    response = fw.execute(aid, challenge, assertion=fw.auth.sign(challenge, counter=2))
    assert response.status == 200, response.body
    published = internal_puts(fw)
    assert len(published) == 1
    result = published[0]
    assert result['payload']['type'] in ('Note', 'Page')
    assert result['payload']['body'] == '승인된 결과'
    assert 'PRIVATE-OTHER' not in json.dumps(published)
    edges = [e for e in fw.events() if e['kind'] == 'edge.put' and e['payload'].get('rtype') == 'PROMOTED_FROM']
    assert len(edges) == 1
    assert (edges[0]['payload']['src'], edges[0]['payload']['dst']) == (result['subject'], fw.target)
    source = api.call('GET', f'/v1/nodes/{fw.target}?include=body', fw.token)
    assert source.status == 200
    assert data(source)['data']['sensitivity'] == 'private'
    assert '정제할 합성 메모 [[f-fw9-other]]' in source.body.decode()
    anonymous = api.call('GET', f'/v1/nodes/{result["subject"]}?include=body,edges', None)
    assert anonymous.status == 200
    assert all(marker not in anonymous.body for marker in (fw.target.encode(), b'f-fw9-other', b'PRIVATE-OTHER'))
    state = fw.status(aid)
    assert state['state'] == 'expired' and state['executed'] is True and state['candidates'] == []
    before = fw.head()
    replay = fw.execute(aid, challenge, assertion=fw.auth.sign(challenge, counter=2))
    assert replay.status == 200 and data(replay)['result'] == data(response)['result']
    assert fw.head() == before and len(internal_puts(fw)) == 1
    proof_events = [e for e in fw.events() if e['payload'].get('action_id') == aid
                    and e['payload'].get('action') in ('publish_external_refine', 'publish')]
    assert {e['payload']['action'] for e in proof_events} == {'publish_external_refine', 'publish'}
    for event in proof_events:
        assert event['actor'] == 'user:sagae' and event['generated_by'] == 'app:fw9-review:action'
        assert {'action_sha', 'cred_id', 'assertion_sha', 'prior_state', 'result_sha'} <= event['payload'].keys()
    assert not [e for e in fw.events() if e['kind'] == 'claim.assert'
                and any(ev.get('record') == fw.target for ev in e['payload'].get('evidence', []))]
