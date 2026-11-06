"""FW9 RED: exact RP/origin and cryptographically bound client data."""
import pytest

from test_publish_async import FW9, api, core, kb_home, data, problem  # noqa: F401


@pytest.mark.parametrize('changes', [
    {'rp_id': 'localhost:4812'}, {'rp_id': '127.0.0.1'}, {'rp_id': 'other.example'},
    {'origin': 'http://127.0.0.1:4812'}, {'origin': 'http://localhost:4813'},
    {'origin': 'https://localhost:4812'}, {'origin': 'http://localhost:4812/'},
    {'origin': 'http://localhost:4812.evil.example'},
])
def test_wrong_rp_or_nonexact_origin_rejected_without_ledger_change(api, monkeypatch, changes):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    challenge = fw.challenge(aid)
    before = fw.head()
    problem(fw.execute(aid, challenge, assertion=fw.auth.sign(challenge, **changes)), 403, 'review_unverified')
    assert fw.head() == before and fw.sent == []


def test_registered_other_rp_credential_cannot_answer_localhost_challenge(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    fw.fs.rp_entries.append(dict(rp_id='other.example', allowed_origins=['https://other.example']))
    fw.fs.credentials['cred-other'] = dict(public_key='synthetic-key', rp_id='other.example')
    aid = fw.ready()
    challenge = fw.challenge(aid)
    before = fw.head()
    assertion = fw.auth.sign(challenge, credential_id='cred-other', rp_id='other.example', origin='https://other.example')
    problem(fw.execute(aid, challenge, assertion=assertion), 403, 'review_unverified')
    assert fw.head() == before


def test_localhost_exact_origin_proof_succeeds_and_meta_advertises_only_registered_rp(api, monkeypatch):
    fw = FW9(api, monkeypatch)
    aid = fw.ready()
    assert fw.execute(aid, fw.challenge(aid)).status == 200
    response = api.call('GET', '/v1/meta', fw.token)
    assert response.status == 200
    hitl = data(response)['data']['write']['hitl']
    assert hitl['available'] is True and hitl['trust_store'] == 'ready'
    assert hitl['rp_ids'] == [dict(rp_id='localhost', allowed_origins=['http://localhost:4812'], registered=True)]
    assert all(marker not in response.body for marker in (b'cred-fw9', b'synthetic-key', b'synthetic-reviewers'))
