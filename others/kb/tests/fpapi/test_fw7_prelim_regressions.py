"""FW7 preliminary-review RED regressions; synthetic data and temporary homes only."""
import copy
import json
from urllib.parse import quote

from test_publish_async import FW9, api, core, data, kb_home  # noqa: F401
import test_http_write as api_harness
from test_write_core import REC
from read.rhelp import E, claim, entity, snap

from kb.core import ids, ledger, spool
from kb.core.canon import canon_json
from kb.project import project_tail
from kb.write import engine, fpquota as Q, write_refs
from kb.write.errors import WriteRejected


SECRET = '-----BEGIN PRIVATE KEY-----'  # Public synthetic detector marker, not a key.


def _raise_source_to_secret(api, rid, key):
    _, sha = ledger.record_head(api.world.led, rid)
    payload = dict(ledger.get_payload(api.world.led, sha), sensitivity='secret')
    ledger.append(api.world.led, [E('record.put', payload, rid, origin='first_party',
                                   actor='user:sagae', idem_key=key)])


def _claim_item(fw, cid, *, subject=None):
    sid = 'n-' + cid[2:]
    subject = subject or 'e:tool:fw7-prelim'
    if subject.startswith('e:'):
        fw.api.world.add(entity(subject))
    fw.api.world.add(snap(sid=sid), claim(cid, subject, '첫 문단입니다.', snap_id=sid,
                                        verification='needs_review'))
    return fw.signal(target=cid)['id']


def _hitl_challenge(fw, item):
    response = fw.api.call('POST', '/v1/hitl/challenge', fw.token,
                           dict(item=item, action='accept', params={}))
    assert response.status == 201, response.body
    return data(response)


def _hitl_resolve(fw, item, challenge, key, counter=1):
    return fw.api.call('POST', f'/v1/hitl/{item}/resolve', fw.token,
                       dict(action='accept', params={}, challenge_id=challenge['challenge_id'],
                            assertion=fw.auth.sign(challenge, counter=counter), idempotency_key=key))


def _proof_state(fw):
    with fw.actions.database() as con:
        return dict(counters=fw.actions.rows(con, 'counter:'),
                    challenges=fw.actions.rows(con, 'challenge:'))


def _action_bytes(fw):
    with fw.actions.database() as con:
        return sum(len(json.dumps(value, ensure_ascii=False).encode())
                   for _, value in fw.actions.rows(con, 'action:'))


def _reserve_editor_spool(api, name, event=None):
    event = event or E('record.put', dict(REC, id='f-' + name, body='spool payload ' * 256),
                      'f-' + name, origin='first_party', actor='app:fw7-cap',
                      idem_key='fw7:spool:' + name, editor_create=True)
    body = dict(events=[event])
    token = Q.identity.set(dict(tok_id='fw7-cap-editor', label='fw7-cap', scope='editor'))
    try:
        with Q.lock():
            Q.reserve(api.world.led, [event], body, name, 'in')
    finally:
        Q.identity.reset(token)
    return len(canon_json(body))


def test_derived_write_and_action_responses_respect_current_source_sensitivity(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.selection['kind'] = 'local'
    editor = api.token('fw7-derived')
    source = api.create(editor, key='fw7-derived:c:source', record=dict(REC, title='SOURCE-TITLE'))
    assert source.status == 201, source.body
    source_id = data(source)['id']
    derived_record = dict(REC, title='DERIVED-CONTENT-TITLE', body='DERIVED-CONTENT-BODY')
    created = api.create(editor, key='fw7-derived:c:derived', record=derived_record)
    assert created.status == 201, created.body
    rid = data(created)['id']
    # PROMOTED_FROM is server-owned; seed the real relation, not a forbidden editor link.
    api.world.add(E('edge.put', dict(id=ids.edge_id(rid, 'PROMOTED_FROM', source_id),
                                    src=rid, dst=source_id, rtype='PROMOTED_FROM'),
                    origin='first_party', actor='user:sagae'))
    prepared = api.call('POST', '/v1/actions', fw.token,
                        dict(action='publish', target=rid, expected_version=1,
                             idempotency_key='fw9-review:a:derived-prepare'))
    assert prepared.status == 202, prepared.body
    aid = data(prepared)['action_id']
    fw.drain()

    def busy(*args, **kwargs):
        raise TimeoutError('synthetic occupied write gate')

    with monkeypatch.context() as patch:
        patch.setattr(engine.Gate, 'acquire', busy)
        pending = api.call('PUT', f'/v1/records/{rid}', editor,
                           dict(change='save', idempotency_key='fw7-derived:e:pending',
                                record=dict(derived_record, expected_version=1)))
    assert pending.status == 202, pending.body
    ref = data(pending)['write_ref']
    spool.mark_failed(api.home / 'spool' / 'in' / (ref + '.json'))
    assert api.call('GET', f'/v1/writes/{ref}?include=body', editor).status == 200
    _raise_source_to_secret(api, source_id, 'fw7:raise-derived-source')
    responses = {}
    for stage in ('before_projection', 'after_projection'):
        if stage == 'after_projection':
            assert project_tail(api.world.led, api.world.gold, None, 10**6).caught_up
        with monkeypatch.context() as patch:
            patch.setattr(api_harness, 'project_tail', lambda *args, **kwargs: None)
            responses[stage] = [
                api.call('PUT', f'/v1/records/{rid}', editor,
                         dict(change='save', idempotency_key='fw7-derived:e:stale-' + stage,
                              record=dict(derived_record, expected_version=0))),
                api.create(editor, key='fw7-derived:c:derived', record=derived_record),
                api.call('GET', f'/v1/writes/{ref}?include=body', editor),
                api.call('GET', f'/v1/actions/{aid}', fw.token),
            ]
    statuses = {stage: [response.status for response in values] for stage, values in responses.items()}
    assert statuses == {stage: [404] * 4 for stage in responses}, statuses
    for values in responses.values():
        for response in values:
            assert 'current' not in data(response) and 'record' not in data(response)
            assert all(marker not in response.body for marker in (b'DERIVED-CONTENT-TITLE', b'DERIVED-CONTENT-BODY'))


def test_claim_hitl_item_is_hidden_and_refused_after_source_becomes_secret(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    cid = 'c-fw7-secret-source'
    item = _claim_item(fw, cid, subject=fw.target)
    challenge = _hitl_challenge(fw, item)
    assert any(value['id'] == item for value in fw.hitl())
    _raise_source_to_secret(api, fw.target, 'fw7:raise-claim-source')
    before_head, before_proof = fw.head(), _proof_state(fw)
    visible = fw.hitl()
    issued = api.call('POST', '/v1/hitl/challenge', fw.token,
                     dict(item=item, action='accept', params={}))
    resolved = _hitl_resolve(fw, item, challenge, 'fw9-review:h:hidden-claim')
    observed = dict(visible=any(value['id'] == item for value in visible),
                    challenge=issued.status, resolve=resolved.status)
    assert observed == dict(visible=False, challenge=404, resolve=404), observed
    assert fw.head() == before_head
    assert _proof_state(fw) == before_proof


def test_credential_shaped_missing_write_id_is_not_echoed(api, caplog, capsys):
    editor = api.token('fw7-path')
    encoded = quote(SECRET, safe='')
    responses = [
        api.call('PUT', '/v1/records/' + encoded, editor,
                 dict(change='save', idempotency_key='fw7-path:e:missing',
                      record=dict(REC, expected_version=1))),
        api.call('POST', '/v1/records/' + encoded + '/tombstone', editor,
                 dict(change='save', idempotency_key='fw7-path:t:missing', reason='retire', expected_version=1)),
    ]
    assert all(response.status in (404, 422) for response in responses)
    captured = capsys.readouterr()
    outputs = [response.body.decode() for response in responses] + [caplog.text, captured.out, captured.err]
    assert all(SECRET not in output and encoded not in output for output in outputs), outputs


def test_actions_and_spools_share_global_retention_cap_both_orders(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.selection['kind'] = 'local'
    fw.candidate['body'] = 'candidate payload ' * 256
    fw.ready()
    retained_actions = _action_bytes(fw)
    # Same canonical event/body sizing that the actual reservation will receive.
    probe_event = E('record.put', dict(REC, id='f-fw7-first', body='spool payload ' * 256),
                    'f-fw7-first', origin='first_party', actor='app:fw7-cap',
                    idem_key='fw7:spool:fw7-first', editor_create=True)
    # Freeze the event constructor's variable attribution/time by reusing the actual event below.
    incoming = len(canon_json(dict(events=[probe_event])))
    monkeypatch.setattr(Q, 'TOKEN_RETAINED', 1_000_000)
    monkeypatch.setattr(Q, 'GLOBAL_RETAINED', retained_actions + incoming - 1)
    refused = None
    try:
        _reserve_editor_spool(api, 'fw7-first', event=probe_event)
    except WriteRejected as error:
        refused = error.code
    for path, value in Q.rows():
        if path.stem == 'fw7-first':
            with Q.lock():
                write_refs.purge_one(path, value)
    monkeypatch.setattr(Q, 'GLOBAL_RETAINED', 1_000_000)
    _reserve_editor_spool(api, 'fw7-second')
    occupied_spools = sum(value['bytes'] for _, value in Q.rows())
    monkeypatch.setattr(Q, 'GLOBAL_RETAINED', _action_bytes(fw) + occupied_spools)
    reverse = fw.prepare(key='fw9-review:a:spool-first')
    assert dict(actions_first=refused, spools_first=reverse.status) == dict(actions_first='spool_full', spools_first=503)


def test_reviewer_candidate_enrollment_is_bounded_and_pruned(api, monkeypatch):
    from kb.commands.reviewer import install_candidate, revoke_credential

    fw = FW9(api, monkeypatch)
    trusted = copy.deepcopy(fw.fs.credentials)

    def enroll(credential_id, public_key='synthetic-key'):
        return api.call('POST', '/v1/reviewer/enroll', fw.token,
                        dict(rp_id='localhost', origin='http://localhost:4812',
                             credential_id=credential_id, public_key=public_key))

    consumed = enroll('fw7-consumed')
    expired = enroll('fw7-expired')
    assert consumed.status == expired.status == 201
    consumed_id, expired_id = data(consumed)['request_id'], data(expired)['request_id']
    install_candidate(consumed_id, filesystem=fw.fs, effective_uid=0)
    revoke_credential('fw7-consumed', filesystem=fw.fs, effective_uid=0)
    monkeypatch.setattr(Q, 'GLOBAL_RETAINED', 8192)
    monkeypatch.setattr(Q, 'TOKEN_RETAINED', 8192)
    oversized = enroll('fw7-oversized', 'X' * 16384)
    admissions = [enroll('fw7-cap-' + str(index), 'K' * 2048) for index in range(6)]

    def expire(con):
        value = fw.actions.load(con, 'enroll:' + expired_id)
        if value is not None:
            value['expires_at'] = fw.now - 1
            fw.actions.save(con, 'enroll:' + expired_id, value)
        return []

    fw.actions.transaction(expire)
    fw.actions.maintenance()
    with fw.actions.database() as con:
        expired_gone = fw.actions.load(con, 'enroll:' + expired_id) is None
        consumed_gone = fw.actions.load(con, 'enroll:' + consumed_id) is None
    observed = dict(oversized_refused=oversized.status in (400, 413, 503),
                    cap_refused=any(response.status == 503 and data(response).get('code') == 'spool_full'
                                    for response in admissions),
                    expired_removed=expired_gone, consumed_removed=consumed_gone,
                    trust_unchanged=fw.fs.credentials == trusted)
    assert all(observed.values()), observed


def test_idempotency_key_is_bound_to_hitl_item(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    first = _claim_item(fw, 'c-fw7-idem-first')
    second = _claim_item(fw, 'c-fw7-idem-second')
    first_challenge = _hitl_challenge(fw, first)
    second_challenge = _hitl_challenge(fw, second)
    key = 'fw9-review:h:shared-item-key'
    committed = _hitl_resolve(fw, first, first_challenge, key)
    assert committed.status == 200, committed.body
    retry = _hitl_resolve(fw, first, first_challenge, key)
    other = _hitl_resolve(fw, second, second_challenge, key, counter=2)
    assert retry.status == 200 and data(retry) == data(committed)
    assert other.status == 409 and data(other).get('code') == 'idem_conflict', other.body


def test_secret_rejection_keeps_safe_hit_spans_and_stored_false(api):
    editor = api.token('fw7-secret-spans')
    body = '😀 앞문장\n' + SECRET + '\n합성 본문'
    response = api.create(editor, key='fw7-secret-spans:c:reject', record=dict(REC, body=body))
    assert response.status == 422, response.body
    value = data(response)
    assert value.get('stored') is False and value.get('hits'), value
    assert SECRET.encode() not in response.body
    hits = [hit for hit in value['hits'] if hit['field'] == 'record.body']
    assert hits
    for hit in hits:
        assert {'field', 'rule', 'start', 'end', 'start_u16', 'end_u16'} <= hit.keys()
        start, end = hit['start'], hit['end']
        assert 0 <= start < end <= len(body)
        assert hit['start_u16'] == len(body[:start].encode('utf-16-le')) // 2
        assert hit['end_u16'] == len(body[:end].encode('utf-16-le')) // 2



def test_expired_candidate_install_refused_before_maintenance(api, monkeypatch):
    import pytest
    from kb.commands.reviewer import install_candidate

    fw = FW9(api, monkeypatch)
    response = api.call('POST', '/v1/reviewer/enroll', fw.token,
                        dict(rp_id='localhost', origin='http://localhost:4812',
                             credential_id='fw7-expired-install', public_key='synthetic-key'))
    assert response.status == 201, response.body
    request_id = data(response)['request_id']
    with fw.actions.database() as con:
        candidate = fw.actions.load(con, 'enroll:' + request_id)
    assert candidate is not None and candidate['expires_at'] > fw.now
    trusted = copy.deepcopy(fw.fs.credentials)
    fw.now = candidate['expires_at'] + 1
    # No API request or maintenance after advancing the injected candidate clock.
    with pytest.raises(ValueError):
        install_candidate(request_id, filesystem=fw.fs, effective_uid=0)
    assert fw.fs.credentials == trusted


def test_consumed_candidate_cannot_be_reinstalled_after_revoke(api, monkeypatch):
    import pytest
    from kb.commands.reviewer import install_candidate, revoke_credential

    fw = FW9(api, monkeypatch)
    credential_id = 'fw7-consumed-reinstall'
    response = api.call('POST', '/v1/reviewer/enroll', fw.token,
                        dict(rp_id='localhost', origin='http://localhost:4812',
                             credential_id=credential_id, public_key='synthetic-key'))
    assert response.status == 201, response.body
    request_id = data(response)['request_id']
    install_candidate(request_id, filesystem=fw.fs, effective_uid=0)
    assert credential_id in fw.fs.credentials
    revoke_credential(credential_id, filesystem=fw.fs, effective_uid=0)
    assert credential_id not in fw.fs.credentials
    trusted = copy.deepcopy(fw.fs.credentials)
    # A consumed request must stay unusable even before its cleanup runs.
    with pytest.raises(ValueError):
        install_candidate(request_id, filesystem=fw.fs, effective_uid=0)
    assert fw.fs.credentials == trusted
