"""FW9 RED: public ASGI routes; deterministic proposed runtime ports.

Missing runtime modules are optional during shared harness initialization;
tests that need the pure signal port import it explicitly in their bodies.
configure_runtime is a proposed injectable boundary, not an existing API. The controller must adapt this seam if implementation chooses
another one; assertions describe the approved ADR behavior.
"""
import copy
import os
import tempfile
from pathlib import Path
import hashlib
import hmac
import importlib
import json
from types import SimpleNamespace

import pytest

from kb.core import ledger
from test_http_write import api, data, header, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401


@pytest.fixture
def kb_home(monkeypatch):
    """Every runtime file stays under the caller's TMPDIR, including core."""
    monkeypatch.delenv('KB_LIVE', raising=False)
    with tempfile.TemporaryDirectory(prefix='fw9-red-', dir=os.environ['TMPDIR']) as root:
        home = Path(root)
        monkeypatch.setenv('KB_HOME', str(home))
        monkeypatch.delenv('KB_SHARE', raising=False)
        yield home


class TrustFS:
    """In-memory privileged filesystem. No real UID changes or /etc access."""
    def __init__(self):
        self.nodes = {p: dict(uid=0, gid=0, mode=0o755 if p != 'reviewers' else 0o644,
                             symlink=False, acl_writable=False, writable_uids=[], inode=i)
                      for i, p in enumerate(('/', 'etc', 'sagae-kb', 'reviewers'), 1)}
        self.credentials = {'cred-fw9': dict(public_key='synthetic-key', rp_id='localhost')}
        self.rp_entries = [dict(rp_id='localhost', allowed_origins=['http://localhost:4812'])]
        self.calls = []
        self.missing = False
        self.unreadable = False
        self.replace_during_read = False

    def inspect(self, path):
        self.calls.append('inspect')
        if self.missing:
            raise FileNotFoundError(path)
        return copy.deepcopy(self.nodes)

    def read(self, path):
        self.calls.append('read')
        if self.unreadable:
            raise PermissionError('synthetic private path must not leak')
        if self.replace_during_read:
            self.nodes['reviewers']['inode'] += 1
        return dict(rp_entries=copy.deepcopy(self.rp_entries),
                    credentials=copy.deepcopy(self.credentials))


class Authenticator:
    """Signature double only: KB still checks counters, state and consumption.

HMAC stands in for the library's cryptographic primitive. It authenticates
all client fields; no browser, real authenticator, or webauthn dependency.
"""
    key = b'FW9-public-test-only-key'

    def sign(self, challenge, **changes):
        value = dict(credential_id='cred-fw9', challenge=challenge['challenge'],
                     rp_id='localhost', origin='http://localhost:4812', uv=True, counter=1)
        value.update(changes)
        raw = json.dumps(value, sort_keys=True).encode()
        return dict(value, signature=hmac.new(self.key, raw, 'sha256').hexdigest())

    def verify(self, *, credential, expected_challenge, expected_rp_id,
               expected_origin, credential_public_key, credential_current_sign_count,
               require_user_verification, **kwargs):
        value = dict(credential)
        signature = value.pop('signature')
        raw = json.dumps(value, sort_keys=True).encode()
        if not hmac.compare_digest(signature, hmac.new(self.key, raw, 'sha256').hexdigest()):
            raise ValueError('invalid signature')
        if (value['challenge'] != expected_challenge or value['rp_id'] != expected_rp_id
                or value['origin'] not in ([expected_origin] if isinstance(expected_origin, str) else expected_origin)
                or (require_user_verification and not value['uv'])
                or credential_public_key != 'synthetic-key'):
            raise ValueError('invalid WebAuthn proof')
        return SimpleNamespace(new_sign_count=value['counter'], credential_id=value['credential_id'],
                               user_verified=value['uv'])


class FW9:
    """Proposed dependency ports: clock, queued worker, trust FS and adapters.

Only adapters and the OS boundary are doubled. All routes, persistence,
challenge binding, counters, reservations and HITL decisions are real SUT.
"""
    def __init__(self, api, monkeypatch):
        self.actions = self.optional_runtime('kb.write.actions')
        self.reviewer = self.optional_runtime('kb.write.reviewer')
        self.api = api
        self.now = 1_800_000_000.0
        self.jobs, self.sent, self.local_calls, self.reservations = [], [], [], []
        self.fs, self.auth = TrustFS(), Authenticator()
        self.external_error = None
        self.before_send = lambda: None
        self.selection = dict(kind='external', backend='fake', model='fake-model', available=True,
                              budget_available=True, deployed=True)
        if self.reviewer is not None:
            self.reviewer.configure_runtime(trust_path=api.home / 'synthetic-reviewers',
                                            filesystem=self.fs, service_uid=1000, agent_uids=[1001],
                                            clock=lambda: self.now, verify_authentication_response=self.auth.verify)
        if self.actions is not None:
            self.actions.configure_runtime(clock=lambda: self.now, submit=self.jobs.append,
                                           local_refine=self.local, select_engine=lambda **kw: dict(self.selection),
                                           external_transport=self.send, before_external_send=lambda: self.before_send(),
                                           reserve_external=self.reserve)
        api.restart()
        self.token = api.token('fw9-review', 'reviewer')
        created = api.create(api.token('fw9-edit'), key='fw9-edit:c:memo',
                             record=dict(REC, title='FW9 memo', body='정제할 합성 메모', sensitivity='private'))
        assert created.status == 201, created.body
        self.target = data(created)['id']
        self.candidate = dict(type='Note', title='정제 결과', body='승인된 결과', sensitivity='private')

    @staticmethod
    def optional_runtime(name):
        """Absent FW9 modules must not prevent public-route assertions.

        Suppress only absence of this exact planned module, preserving errors
        from an existing module with a broken transitive dependency. No fake
        application module, route, or behavior is installed.
        """
        try:
            return importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
            return None

    def local(self, *args, **kwargs):
        self.local_calls.append((args, kwargs))
        return dict(candidates=[dict(self.candidate)], engine=dict(kind='local', backend='fake', model='small'),
                    cost_usd='0', duration_ms=17, external_needed=self.selection['kind'] == 'external')

    def reserve(self, *args, **kwargs):
        reservation = dict(args=args, kwargs=kwargs, state='reserved')
        self.reservations.append(reservation)
        return reservation

    def send(self, request_bytes, *, engine, model, max_retries, **kwargs):
        self.sent.append(dict(body=request_bytes, engine=engine, model=model, max_retries=max_retries, **kwargs))
        if self.external_error:
            raise self.external_error
        return dict(candidates=[dict(self.candidate)], cost_usd='0.0025', duration_ms=29,
                    engine=dict(kind='external', backend=engine, model=model))

    def drain(self):
        while self.jobs:
            self.jobs.pop(0)()

    def prepare(self, key='fw9-review:a:prepare', action='publish', **extra):
        return self.api.call('POST', '/v1/actions', self.token,
                             dict(action=action, target=self.target, expected_version=1,
                                  idempotency_key=key, **extra))

    def ready(self):
        response = self.prepare()
        assert response.status == 202, response.body
        aid = data(response)['action_id']
        self.drain()
        assert self.status(aid)['state'] == 'ready'
        return aid

    def status(self, aid):
        response = self.api.call('GET', f'/v1/actions/{aid}', self.token)
        assert response.status == 200, response.body
        return data(response)['data']

    def challenge(self, aid, action='publish'):
        response = self.api.call('POST', '/v1/actions/challenge', self.token,
                                 dict(action_id=aid, action=action))
        assert response.status == 201, response.body
        return data(response)

    def execute(self, aid, challenge=None, *, action='execute', key='fw9-review:a:execute', assertion=None):
        body = dict(idempotency_key=key)
        if challenge is not None:
            body.update(challenge_id=challenge['challenge_id'],
                        assertion=self.auth.sign(challenge) if assertion is None else assertion)
        return self.api.call('POST', f'/v1/actions/{aid}/{action}', self.token, body)

    def head(self):
        return ledger.head(self.api.world.led)

    def events(self):
        return ledger.iter_events(self.api.world.led, 0, 10000)

    def change_source(self, **changes):
        current = dict(REC, id=self.target, title='FW9 memo', body='정제할 합성 메모', sensitivity='private')
        current.update(changes)
        self.api.world.add(dict(kind='record.put', origin='first_party', actor='user:sagae',
                                subject=self.target, idem_key='fw9:source:changed', payload=current))

    def signal(self, kind='gate_unresolved', resolved=False, verdict=1, target=None, **extra):
        return self.actions.reconcile_hitl(dict(kind=kind, target=target or self.target, verdict=verdict,
                                               unresolved=not resolved, attempted=['automatic'],
                                               reason='synthetic unresolved intent', candidates=[], evidence=[], **extra))

    def hitl(self):
        response = self.api.call('GET', '/v1/hitl', self.token)
        assert response.status == 200, response.body
        return data(response)['data']['items']


def test_publish_accepts_async_and_replays_one_job(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    first, replay = fw.prepare(), fw.prepare()
    assert first.status == replay.status == 202
    aid = data(first)['action_id']
    assert data(first)['state'] == 'preparing'
    assert data(replay)['action_id'] == aid
    assert data(first)['status_url'] == f'/v1/actions/{aid}'
    assert header(first, 'location') == f'/v1/actions/{aid}'
    assert header(first, 'retry-after') == '1'
    assert len(fw.jobs) == 1 and fw.sent == [] and fw.reservations == []
    assert fw.status(aid)['candidates'] == []


def test_ready_contract_cost_duration_and_private_candidates(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    envelope = api.call('GET', f'/v1/actions/{aid}', fw.token)
    assert data(envelope)['schema_version'] == '0.5.0'
    state = data(envelope)['data']
    required = {'action_id', 'action', 'target', 'expected_version', 'state', 'created_at',
                'expires_at', 'candidates', 'engine', 'cost_usd', 'duration_ms', 'code',
                'refinement_mode', 'external_refine', 'executed'}
    assert required <= state.keys()
    assert state['engine'] == dict(kind='local', backend='fake', model='small')
    assert state['cost_usd'] == '0' and state['duration_ms'] == 17
    assert state['refinement_mode'] == 'local_only' and state['executed'] is False
    assert all(c['sensitivity'] == 'private' and len(c['body_sha']) == 64 for c in state['candidates'])
    assert set(state['external_refine']) == {'status', 'external_payload_sha', 'engine', 'request_preview'}


@pytest.mark.parametrize('who', ['other', 'rotated', 'viewer', 'editor', 'anonymous'])
def test_poll_ownership_is_tok_id_and_hides_existence(api, monkeypatch, who):
    from kb.serve import http as H
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    if who == 'rotated':
        token = H.change_token('fw9-review', rotate=True)
    else:
        token = None if who == 'anonymous' else api.token('fw9-' + who, who if who in ('viewer', 'editor') else 'reviewer')
    actual = api.call('GET', f'/v1/actions/{aid}', token)
    missing = api.call('GET', '/v1/actions/action-missing', token)
    problem(actual, 404, 'not_found')
    assert actual.body == missing.body


def test_prepare_timeout_includes_queue_and_late_result_cannot_revive(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    response = fw.prepare()
    assert response.status == 202
    aid = data(response)['action_id']
    fw.now += 119
    assert fw.status(aid)['state'] == 'preparing'
    fw.now += 2
    state = fw.status(aid)
    assert (state['state'], state['code'], state['candidates']) == ('failed', 'prepare_timeout', [])
    fw.drain()
    assert fw.status(aid)['state'] == 'failed' and fw.sent == []


def test_ready_expires_fifteen_minutes_after_completion_and_retains_metadata_thirty_days(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    response = fw.prepare()
    assert response.status == 202
    aid = data(response)['action_id']
    fw.now += 60
    fw.drain()
    fw.now += 899
    assert fw.status(aid)['state'] == 'ready'
    fw.now += 2
    state = fw.status(aid)
    assert state['state'] == 'expired' and state['candidates'] == []
    assert '승인된 결과' not in json.dumps(state, ensure_ascii=False)
    before = fw.head()
    problem(fw.execute(aid), 409, 'review_stale')
    problem(api.call('POST', '/v1/actions/challenge', fw.token, dict(action_id=aid, action='publish')),
            409, 'review_stale')
    assert fw.head() == before
    fw.now += 29 * 86400
    assert fw.status(aid)['state'] == 'expired'
    fw.now += 2 * 86400
    problem(api.call('GET', f'/v1/actions/{aid}', fw.token), 404, 'not_found')


@pytest.mark.parametrize('operation', ['challenge', 'execute'])
def test_preparing_rejects_confirmation(api, monkeypatch, operation):
    fw = FW9(api, monkeypatch)
    response = fw.prepare()
    assert response.status == 202
    aid = data(response)['action_id']
    response = (api.call('POST', '/v1/actions/challenge', fw.token, dict(action_id=aid, action='publish'))
                if operation == 'challenge' else fw.execute(aid))
    problem(response, 409, 'write_in_flight')


@pytest.mark.parametrize('action', ['release', 'declassify'])
def test_non_llm_actions_prepare_synchronously_and_do_not_enter_hitl(api, monkeypatch, action):
    fw = FW9(api, monkeypatch)
    if action == 'release':
        fw.change_source(props={'quarantine': True})
        version = 2
    else:
        version = 1
    body = dict(action=action, target=fw.target, expected_version=version, idempotency_key='fw9-review:a:sync')
    if action == 'declassify':
        body['sensitivity'] = 'internal'
    response = api.call('POST', '/v1/actions', fw.token, body)
    assert response.status == 201, response.body
    assert fw.local_calls == [] and fw.sent == [] and fw.hitl() == []
    if action == 'release':
        assert '정제할 합성 메모' not in response.body.decode()
