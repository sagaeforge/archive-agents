"""FW9 review RED regressions for 4276b56; no live services or real keys.

Use the existing temporary-home/public-API harness. Only infrastructure,
WebAuthn cryptography, and the LLM backend response are doubled.
"""
from types import SimpleNamespace

from test_publish_async import FW9, api, core, data, kb_home  # noqa: F401
from read.rhelp import E, claim, entity, record, snap

from kb.core import ids, ledger, opsdb
from kb.extract import support
from kb.extract.types import Preflight, Result
from kb.project.apply import security_state


def _publish_result(fw, suffix, counter):
    prepared = fw.prepare(key=f'fw9-review:a:review-prepare-{suffix}')
    assert prepared.status == 202, prepared.body
    aid = data(prepared)['action_id']
    fw.drain()
    assert fw.status(aid)['state'] == 'ready'
    challenge = fw.challenge(aid)
    executed = fw.execute(aid, challenge, key=f'fw9-review:a:review-execute-{suffix}',
                          assertion=fw.auth.sign(challenge, counter=counter))
    assert executed.status == 200, executed.body
    rid, = data(executed)['result']['ids']
    public = fw.api.call('GET', f'/v1/nodes/{rid}?include=body', None)
    assert public.status == 200, public.body
    assert data(public)['data']['sensitivity'] == 'internal'
    return aid, rid


def test_real_unsupported_entailment_gate_creates_open_hitl(api, monkeypatch):
    """F1: actual support queue/judge output must reach the public HITL list."""
    import kb.project

    fw = FW9(api, monkeypatch)
    cid = 'c-fw9-review-unsupported'
    statement = '도구의 한도는 100개다.'
    api.world.add(snap(paras=(statement,)), entity('e:tool:fw9-review'),
                  claim(cid, 'e:tool:fw9-review', statement, verification='needs_review'))
    # The API fixture owns a real projected DB outside the production gold pointer.
    monkeypatch.setattr(kb.project, 'current_gold_path', lambda: api.world.path)
    calls = []

    def extract(job, permit):
        calls.append(job)
        return Result(window_id=job.window.window_id, backend='local', model=job.model,
                      raw='{"supported": false}', cost_usd=0.0)

    backend = SimpleNamespace(external=False, preflight=lambda: Preflight(ok=True), extract=extract)
    candidate = SimpleNamespace(backend='local', model='fake-support', budget_usd=None,
                                same_vendor=False, reason='regression backend')
    router = SimpleNamespace(plan=lambda *args, **kwargs: SimpleNamespace(cands=[candidate], stop=None))
    con = opsdb.connect()
    try:
        opsdb.queue_put(con, support.QUEUE, cid)
    finally:
        con.close()
    outcome = support.run_queue({'local': backend}, router, limit=1)
    assert outcome['checked'] == 1 and outcome['unsupported'] == 1, outcome
    assert len(calls) == 1
    reviews = [event for event in fw.events()
               if event['kind'] == 'claim.review' and event['subject'] == cid]
    assert reviews and reviews[-1]['payload']['support_check'] == 'unsupported'
    # No fw.signal/reconcile_hitl call: the real gate result must create this.
    items = [item for item in fw.hitl() if item['target'] == cid]
    assert len(items) == 1, items
    assert items[0]['kind'] == 'gate_unresolved' and items[0]['state'] == 'open'


def test_auto_resolved_new_verdict_closes_previous_verdict_item(api, monkeypatch):
    """F2: automatic resolution applies across earlier verdicts for the target."""
    fw = FW9(api, monkeypatch)
    first = fw.signal(kind='gate_unresolved', verdict=1)
    assert fw.actions.get_hitl(first['id'])['state'] == 'open'
    fw.signal(kind='gate_unresolved', verdict=2, resolved=True)
    assert fw.hitl() == []
    assert fw.actions.get_hitl(first['id'])['state'] == 'auto_resolved'


def test_publish_exemption_binds_payload_and_promotion_destination(api, monkeypatch):
    """F3: two independent attacks must not reuse an earlier publication grant."""
    fw = FW9(api, monkeypatch)
    fw.selection['kind'] = 'local'
    _, changed_result = _publish_result(fw, 'payload', counter=1)
    reused_action, redirected_result = _publish_result(fw, 'destination', counter=2)
    # Both control results were independently verified and readable as internal.
    published = next(event['payload'] for event in fw.events()
                     if event['kind'] == 'record.put' and event['subject'] == changed_result)
    unverified = dict(published, body='Later payload without a new WebAuthn decision')
    api.world.add(E('record.put', unverified, changed_result, origin='first_party',
                    actor='user:sagae', expected_version=1))
    other = 'f-fw9-review-other-private'
    api.world.add(record(other, 'Another private source', 'private', body='Private source body'))
    api.world.add(E('edge.put',
                    dict(id=ids.edge_id(redirected_result, 'PROMOTED_FROM', other),
                         src=redirected_result, dst=other, rtype='PROMOTED_FROM',
                         props={'review_action': reused_action}),
                    origin='first_party', actor='user:sagae'))
    # Gather both results before asserting so the first attack does not hide the second.
    effective = security_state(api.world.gold, api.world.led)
    observed = {}
    for attack, rid in [('payload', changed_result), ('destination', redirected_result)]:
        observed[attack] = {
            'effective': effective[rid],
            'projected': api.world.gold.execute('SELECT sensitivity FROM head WHERE id=?', (rid,)).fetchone()[0],
            'anonymous_status': api.call('GET', f'/v1/nodes/{rid}?include=body', None).status,
        }
    assert observed == {
        'payload': {'effective': 2, 'projected': 2, 'anonymous_status': 404},
        'destination': {'effective': 2, 'projected': 2, 'anonymous_status': 404},
    }, observed


def test_release_of_ordinary_private_note_cannot_bypass_declassify(api, monkeypatch):
    """F4: valid reviewer proof cannot release an ordinary nonquarantined Note."""
    fw = FW9(api, monkeypatch)
    version, sha = ledger.record_head(api.world.led, fw.target)
    original = ledger.get_payload(api.world.led, sha)
    assert original['type'] == 'Note' and original['sensitivity'] == 'private'
    assert not (original.get('props') or {}).get('quarantine')
    assert 'quarantine_from' not in (original.get('props') or {})
    before = fw.head()
    response = fw.prepare(action='release')
    if response.status == 201:
        aid = data(response)['action_id']
        response = api.call('POST', '/v1/actions/challenge', fw.token,
                            dict(action_id=aid, action='release'))
        if response.status == 201:
            challenge = data(response)
            response = fw.execute(aid, challenge, key='fw9-review:a:ordinary-release')
    assert 400 <= response.status < 500, response.body
    assert fw.head() == before
    current_version, current_sha = ledger.record_head(api.world.led, fw.target)
    assert current_version == version
    assert ledger.get_payload(api.world.led, current_sha)['sensitivity'] == 'private'
