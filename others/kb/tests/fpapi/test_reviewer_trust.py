"""FW9 RED: root trust checked through a synthetic OS boundary only."""
import importlib

import pytest

from test_publish_async import FW9, api, core, kb_home, data, problem  # noqa: F401

FAULTS = ['file_owner', 'file_group_owner', 'parent_owner', 'file_group_write', 'parent_world_write', 'file_symlink',
          'parent_symlink', 'acl', 'service_writable', 'agent_writable', 'replacement', 'missing', 'unreadable']


def unsafe(fw, fault):
    if fault == 'missing':
        fw.fs.missing = True
    elif fault == 'unreadable':
        fw.fs.unreadable = True
    elif fault == 'replacement':
        fw.fs.replace_during_read = True
    else:
        node, field, value = {
            'file_owner': ('reviewers', 'uid', 1000), 'file_group_owner': ('reviewers', 'gid', 1000), 'parent_owner': ('etc', 'uid', 1001),
            'file_group_write': ('reviewers', 'mode', 0o664),
            'parent_world_write': ('sagae-kb', 'mode', 0o777),
            'file_symlink': ('reviewers', 'symlink', True), 'parent_symlink': ('etc', 'symlink', True),
            'acl': ('reviewers', 'acl_writable', True),
            'service_writable': ('reviewers', 'writable_uids', [1000]),
            'agent_writable': ('sagae-kb', 'writable_uids', [1001]),
        }[fault]
        fw.fs.nodes[node][field] = value


@pytest.mark.parametrize('phase', ['start', 'prepare', 'challenge', 'execute', 'hitl_challenge', 'hitl_resolve'])
@pytest.mark.parametrize('fault', FAULTS)
def test_unsafe_trust_blocks_all_phases_with_safe_meta_and_no_ledger_change(api, monkeypatch, phase, fault):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    item = fw.signal()['id']
    hitl_challenge = api.call('POST', '/v1/hitl/challenge', fw.token, dict(item=item, action='accept', params={}))
    assert hitl_challenge.status == 201
    hc = data(hitl_challenge)
    unsafe(fw, fault)
    before = fw.head()
    reads = len(fw.fs.calls)
    if phase == 'start':
        api.restart()
        assert len(fw.fs.calls) > reads, 'startup must inspect trust before any prepare'
        response = fw.prepare(key='fw9-review:a:unsafe-start')
    elif phase == 'prepare':
        response = fw.prepare(key='fw9-review:a:unsafe')
    elif phase == 'challenge':
        response = api.call('POST', '/v1/actions/challenge', fw.token, dict(action_id=aid, action='publish'))
    elif phase == 'hitl_challenge':
        response = api.call('POST', '/v1/hitl/challenge', fw.token, dict(item=item, action='accept', params={}))
    elif phase == 'hitl_resolve':
        response = api.call('POST', f'/v1/hitl/{item}/resolve', fw.token,
                            dict(action='accept', params={}, challenge_id=hc['challenge_id'],
                                 assertion=fw.auth.sign(hc), idempotency_key='fw9-review:h:unsafe'))
    else:
        response = fw.execute(aid, challenge)
    problem(response, 503, 'review_trust_unavailable')
    assert len(fw.fs.calls) > reads and fw.head() == before
    meta = api.call('GET', '/v1/meta', fw.token)
    assert meta.status == 200
    hitl = data(meta)['data']['write']['hitl']
    assert hitl['available'] is False and hitl['rp_ids'] == []
    assert hitl['trust_store'] in ('missing', 'unreadable', 'unsafe')
    assert all(marker not in meta.body for marker in (b'cred-fw9', b'synthetic-key', b'synthetic-reviewers',
                                                      b'synthetic private path'))


def test_candidate_registration_cannot_activate_key_and_privileged_install_revoke_can(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    response = api.call('POST', '/v1/reviewer/enroll', fw.token,
                        dict(rp_id='localhost', origin='http://localhost:4812', credential_id='candidate',
                             public_key='synthetic-key'))
    assert response.status == 201
    commands = importlib.import_module('kb.commands.reviewer')
    request_id = data(response)['request_id']
    assert 'candidate' not in fw.fs.credentials
    aid = fw.ready()
    challenge = fw.challenge(aid)
    before = fw.head()
    problem(fw.execute(aid, challenge, assertion=fw.auth.sign(challenge, credential_id='candidate')),
            403, 'review_unverified')
    assert fw.head() == before
    # Proposed pure privileged command port; effective UID and writes are doubles.
    with pytest.raises(PermissionError):
        commands.install_candidate(request_id, filesystem=fw.fs, effective_uid=1000)
    assert 'candidate' not in fw.fs.credentials
    commands.install_candidate(request_id, filesystem=fw.fs, effective_uid=0)
    assert fw.fs.credentials['candidate']['rp_id'] == 'localhost'
    assert fw.execute(aid, challenge, assertion=fw.auth.sign(challenge, credential_id='candidate')).status == 200
    with pytest.raises(PermissionError):
        commands.revoke_credential('candidate', filesystem=fw.fs, effective_uid=1000)
    assert 'candidate' in fw.fs.credentials
    commands.revoke_credential('candidate', filesystem=fw.fs, effective_uid=0)
    assert 'candidate' not in fw.fs.credentials
    prepared = fw.prepare(key='fw9-review:a:revoked')
    assert prepared.status == 202
    second = data(prepared)['action_id']
    fw.drain()
    challenge = fw.challenge(second)
    before = fw.head()
    problem(fw.execute(second, challenge, key='fw9-review:a:revoked-exec',
                       assertion=fw.auth.sign(challenge, credential_id='candidate', counter=2)), 403, 'review_unverified')
    assert fw.head() == before
