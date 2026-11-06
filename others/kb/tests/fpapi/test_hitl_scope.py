"""FW9 RED: reviewer-only surfaces and current source visibility."""
import pytest

from test_publish_async import FW9, api, core, kb_home, data, problem  # noqa: F401


@pytest.mark.parametrize('role', [None, 'editor', 'viewer'])
@pytest.mark.parametrize('route', ['/v1/hitl/challenge', '/v1/actions/challenge'])
def test_challenges_require_reviewer_bearer_on_unix_and_tcp(api, monkeypatch, role, route):
    fw = FW9(api, monkeypatch)
    token = None if role is None else api.token('scope-' + role, role)
    for tcp in (False, True):
        before = fw.head()
        response = api.call('POST', route, token,
                            dict(item='missing', action_id='missing', action='publish'), tcp=tcp)
        problem(response, 401 if role is None else 403, 'token_required' if role is None else 'scope_denied')
        assert fw.head() == before


@pytest.mark.parametrize('role', [None, 'editor', 'viewer'])
def test_hitl_list_and_action_prepare_require_reviewer(api, monkeypatch, role):
    fw = FW9(api, monkeypatch)
    token = None if role is None else api.token('scope-' + role, role)
    for method, route, body in [('GET', '/v1/hitl', None),
                                ('POST', '/v1/actions', dict(action='publish', target=fw.target,
                                 expected_version=1, idempotency_key='scope:a:forbidden'))]:
        problem(api.call(method, route, token, body), 401 if role is None else 403,
                'token_required' if role is None else 'scope_denied')
    assert fw.sent == [] and fw.jobs == []


@pytest.mark.parametrize('hidden', ['secret', 'quarantined', 'tombstoned'])
def test_action_poll_and_replay_recheck_source_visibility(api, monkeypatch, hidden):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    if hidden == 'secret':
        fw.change_source(sensitivity='secret')
    elif hidden == 'quarantined':
        fw.change_source(props={'quarantine': True})
    else:
        api.world.add(dict(kind='record.tombstone', actor='user:sagae', origin='first_party',
                           subject=fw.target, idem_key='fw9:hide', payload=dict(id=fw.target, reason='synthetic')))
    before = fw.head()
    response = api.call('GET', f'/v1/actions/{aid}', fw.token)
    problem(response, 404, 'not_found')
    assert '정제할 합성 메모' not in response.body.decode() and '승인된 결과' not in response.body.decode()
    problem(fw.prepare(), 404, 'not_found')
    assert fw.head() == before and fw.sent == []
