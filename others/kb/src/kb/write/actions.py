"""ADR-0005 human actions; operational state shares the decision transaction.

Only adapter functions are injectable. HTTP requests cannot select adapters,
trust files, effective UIDs, or externally supplied candidate payloads.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone

from kb.core import cas, ids, ledger
from kb.core.canon import canon_json
from kb.write import engine, fpquota as Q, record, reviewer, secrets_scan
from kb.write.errors import WriteRejected

KINDS = {'topic_ambiguity', 'source_policy', 'liveness_unresolved', 'gate_unresolved'}
_pool = None
_runtime = dict(clock=time.time, submit=None, local_refine=None, select_engine=None,
                external_transport=None, before_external_send=lambda: None, reserve_external=None)


def configure_runtime(**ports):
    if set(ports) - set(_runtime):
        raise ValueError('Unknown action adapter')
    _runtime.update(ports)


def now():
    return _runtime['clock']()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canon_json(value)).hexdigest()


def fail(code, status):
    reviewer.reject(code, status)


@contextmanager
def database():
    con = ledger.open_ledger()
    try:
        con.execute('CREATE TABLE IF NOT EXISTS reviewer_state (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID')
        yield con
    finally:
        con.close()


def load(con, key):
    row = con.execute('SELECT v FROM reviewer_state WHERE k=?', (key,)).fetchone()
    return json.loads(row[0]) if row else None


def save(con, key, value):
    con.execute('INSERT INTO reviewer_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
                (key, json.dumps(value, ensure_ascii=False, sort_keys=True)))


def rows(con, prefix):
    return [(key, json.loads(raw)) for key, raw in con.execute(
        'SELECT k,v FROM reviewer_state WHERE k LIKE ? ORDER BY k', (prefix + '%',))]


def transaction(build):
    with database():
        pass
    return engine.review_transaction(build)


def identity():
    info = Q.identity.get()
    if not info:
        fail('token_required', 401)
    if info['scope'] != 'reviewer':
        fail('scope_denied', 403)
    return info


def key_for(info, key, suffix):
    if not isinstance(key, str) or not key or len(key) > 256 or '\0' in key:
        fail('schema_invalid', 400)
    record.reject_secret_key('idempotency_key', key)
    return 'review:' + digest([info['label'], key, suffix])


def source(con, target, release=False):
    if release:
        head = ledger.record_head(con, target)
        last = con.execute("SELECT kind,payload_sha FROM event WHERE subject=? AND kind IN "
                           "('record.put','record.tombstone','record.redact') ORDER BY seq DESC LIMIT 1", (target,)).fetchone()
        if head is None or last is None or last[0] != 'record.put':
            fail('not_found', 404)
        payload = ledger.get_payload(con, last[1])
    else:
        head, last, payload = record._record_state(con, target)
        if last[0] != 'record.put':
            fail('not_found', 404)
    if payload is None:
        fail('not_found', 404)
    payload = copy.deepcopy(payload)
    if 'body' not in payload and payload.get('body_sha'):
        payload['body'] = cas.get(payload['body_sha'], 'fp').decode('utf-8')
    return head[0], payload


def visibility(con, action):
    return source(con, action['target'], action['action'] == 'release')


def wipe(action):
    action['candidates'] = []
    action.pop('_source', None)
    action.pop('_request', None)
    action['external_refine']['request_preview'] = None


def refresh(con, action):
    elapsed = now() - action['created_at']
    if elapsed > 30 * 86400:
        con.execute('DELETE FROM reviewer_state WHERE k=?', ('action:' + action['action_id'],))
        fail('not_found', 404)
    version, payload = visibility(con, action)
    stale = version != action['expected_version'] or digest(payload) != action['_source_sha']
    if action['state'] == 'preparing' and now() - action['_phase_at'] >= 120:
        action.update(state='failed', code='prepare_timeout')
        wipe(action)
    elif (action['state'] == 'ready' and now() >= action['expires_at']) or stale:
        action['state'] = 'expired'
        wipe(action)
    save(con, 'action:' + action['action_id'], action)
    return action


def owned(con, aid, info):
    action = load(con, 'action:' + str(aid))
    if action is None or info is None or action['tok_id'] != info['tok_id']:
        fail('not_found', 404)
    return refresh(con, action)


def public(action):
    value = {k: copy.deepcopy(v) for k, v in action.items()
             if not k.startswith('_') and k not in ('tok_id', 'label', 'prepare_response')}
    for key in ('created_at', 'expires_at'):
        if value.get(key) is not None:
            value[key] = public_time(value[key])
    return value


def public_time(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def submit(job):
    global _pool
    if _runtime['submit'] is not None:
        return _runtime['submit'](job)
    if _pool is None:
        _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='kb-publish')
    return _pool.submit(job)


def _capacity(con, action):
    retained = len(json.dumps(action, ensure_ascii=False).encode())
    own = total = 0
    for _, other in rows(con, 'action:'):
        if other['action_id'] == action['action_id']:
            continue
        size = len(json.dumps(other, ensure_ascii=False).encode())
        total += size
        if other['tok_id'] == action['tok_id']:
            own += size
    for _, value in Q.rows():
        total += value.get('bytes', 0)
        if value.get('tok_id') == action['tok_id']:
            own += value.get('bytes', 0)
    if total + retained > Q.GLOBAL_RETAINED or own + retained > Q.TOKEN_RETAINED:
        fail('spool_full', 503)


def prepare(obj):
    info = identity()
    reviewer.require_trust()
    action_name = obj.get('action')
    if action_name not in ('publish', 'release', 'declassify'):
        fail('schema_invalid', 400)
    result = {}
    namespace = key_for(info, obj.get('idempotency_key'), 'prepare')
    def build(con):
        reviewer.require_trust()
        version, payload = source(con, obj.get('target'), action_name == 'release')
        prior = load(con, namespace)
        fingerprint = digest({k: v for k, v in obj.items() if k != 'idempotency_key'})
        if prior:
            if prior['fingerprint'] != fingerprint:
                fail('idem_conflict', 409)
            old = owned(con, prior['action_id'], info)
            result.update(response=old['prepare_response'], status=202 if action_name == 'publish' else 201)
            return []
        if obj.get('expected_version') != version:
            fail('review_stale', 409)
        if action_name == 'publish' and payload.get('type') != 'Note':
            fail('schema_invalid', 400)
        if action_name != 'release' and secrets_scan.scan_record(payload):
            fail('secret_detected', 403)
        if action_name == 'declassify' and obj.get('sensitivity') not in ('internal', 'public'):
            fail('schema_invalid', 400)
        aid = 'a-' + secrets.token_hex(16)
        response = dict(action_id=aid, state='preparing' if action_name == 'publish' else 'ready',
                        status_url='/v1/actions/' + aid)
        action = dict(action_id=aid, action=action_name, target=payload['id'], expected_version=version,
                      state=response['state'], created_at=now(), expires_at=None if action_name == 'publish' else now() + 900,
                      candidates=[], engine=None, cost_usd=None, duration_ms=None, code=None, executed=False,
                      refinement_mode='local_only', external_refine=dict(status='not_needed', external_payload_sha=None,
                                                                       engine=None, request_preview=None),
                      tok_id=info['tok_id'], label=info['label'], prepare_response=response,
                      _source=payload, _source_sha=digest(payload), _phase_at=now(), _generation=0,
                      _sensitivity=obj.get('sensitivity'))
        _capacity(con, action)
        save(con, 'action:' + aid, action)
        save(con, namespace, dict(fingerprint=fingerprint, action_id=aid))
        result.update(response=response, status=202 if action_name == 'publish' else 201)
        return []
    transaction(build)
    response = result['response']
    if result['status'] == 202:
        # Durable phase ownership prevents a replay from creating another job.
        scheduled = []
        def schedule(con):
            action = load(con, 'action:' + response['action_id'])
            if not action.get('_scheduled'):
                action['_scheduled'] = True
                save(con, 'action:' + action['action_id'], action)
                scheduled.append(action['action_id'])
            return []
        transaction(schedule)
        for aid in scheduled:
            submit(lambda aid=aid: run_local(aid))
    return result['status'], response


def get_action(aid, info):
    reviewer.require_trust()
    result = {}
    def build(con):
        reviewer.require_trust()
        action = load(con, 'action:' + str(aid))
        if action is None or not info or action['tok_id'] != info['tok_id']:
            fail('not_found', 404)
        if now() - action['created_at'] > 30 * 86400:
            con.execute('DELETE FROM reviewer_state WHERE k=?', ('action:' + str(aid),))
            result['removed'] = True
        else:
            result['data'] = public(refresh(con, action))
        return []
    transaction(build)
    if result.get('removed'):
        fail('not_found', 404)
    return result['data']


def maintenance():
    """Request-driven cleanup, with expiry also enforced on every use."""
    def build(con):
        for key, action in rows(con, 'action:'):
            if now() - action['created_at'] > 30 * 86400:
                con.execute('DELETE FROM reviewer_state WHERE k=?', (key,))
                continue
            if action['state'] == 'preparing' and now() - action['_phase_at'] >= 120:
                action.update(state='failed', code='prepare_timeout')
                wipe(action)
            elif action['state'] == 'ready' and now() >= action['expires_at']:
                action['state'] = 'expired'
                wipe(action)
            save(con, key, action)
        for key, challenge in rows(con, 'challenge:'):
            if now() - challenge['created_at'] >= 120:
                con.execute('DELETE FROM reviewer_state WHERE k=?', (key,))
        return []
    transaction(build)


def candidates_from(result):
    output = []
    for candidate in result.get('candidates', []):
        if candidate.get('type') not in ('Note', 'Page'):
            fail('schema_invalid', 400)
        value = {k: candidate[k] for k in ('type', 'title', 'body')}
        if secrets_scan.scan_record(value):
            fail('secret_detected', 403)
        value.update(sensitivity='private', body_sha=digest(value['body'].encode('utf-8')))
        output.append(value)
    if not output:
        fail('schema_invalid', 400)
    return output


def run_local(aid):
    with database() as con:
        action = load(con, 'action:' + aid)
        if action is None or action['state'] != 'preparing':
            return
        payload = action['_source']
        generation = action['_generation']
    # No external adapter participates in local planning or refinement.
    try:
        selection = (_runtime['select_engine'](memo=copy.deepcopy(payload))
                     if _runtime['select_engine'] else dict(kind='local', available=False))
        result = (_runtime['local_refine'](memo=copy.deepcopy(payload)) if _runtime['local_refine'] else
                  dict(candidates=[dict(type='Note', title=payload['title'], body=payload['body'])],
                       engine=dict(kind='local', backend='local', model='identity'), cost_usd='0', duration_ms=0))
        ready_candidates = candidates_from(result)
        allowed = (selection.get('kind') == 'external' and all(selection.get(k, False)
                   for k in ('available', 'budget_available', 'deployed')))
        # Only this memo is serialized: no linked record traversal or evidence.
        request = json.dumps(dict(engine=selection.get('backend'), model=selection.get('model'),
                                  memo={k: payload[k] for k in ('title', 'body')},
                                  parameters={}), ensure_ascii=False, sort_keys=True).encode('utf-8')
        def complete(con):
            current = load(con, 'action:' + aid)
            if current is None:
                return []
            refresh(con, current)
            if current['state'] != 'preparing' or current['_generation'] != generation:
                return []
            current.update(state='ready', expires_at=now() + 900, candidates=ready_candidates,
                           engine=result['engine'], cost_usd='0',
                           duration_ms=int((now() - current['_phase_at']) * 1000) + result.get('duration_ms', 0))
            current['_selection'] = selection
            if allowed:
                current['_request'] = request.decode('utf-8')
                current['external_refine'] = dict(status='consent_required', external_payload_sha=digest(request),
                                                  engine=dict(kind='external', backend=selection['backend'], model=selection['model']),
                                                  request_preview=request.decode('utf-8'))
            else:
                current['external_refine']['status'] = 'not_needed' if selection.get('kind') == 'local' else 'unavailable'
            _capacity(con, current)
            save(con, 'action:' + aid, current)
            return []
        transaction(complete)
    except (WriteRejected, ValueError, KeyError, OSError):
        mark_failed(aid, 'prepare_failed')


def mark_failed(aid, code):
    def build(con):
        action = load(con, 'action:' + aid)
        if action and action['state'] == 'preparing':
            action.update(state='failed', code=code)
            wipe(action)
            save(con, 'action:' + aid, action)
        return []
    transaction(build)


def binding(action, operation):
    result = dict(action_id=action['action_id'], action=operation, target=action['target'],
                  version=action['expected_version'], source_sha=action['_source_sha'],
                  generation=action['_generation'])
    if operation == 'publish_external_refine':
        result.update(external_payload_sha=digest(action.get('_request', '').encode('utf-8')),
                      engine=action.get('_selection', {}).get('backend'), model=action.get('_selection', {}).get('model'))
    else:
        result.update(candidates=action['candidates'], sensitivity=action.get('_sensitivity'))
    return digest(result)


def issue(con, subject, operation, action_sha, info, **extra):
    cid = 'ch-' + secrets.token_hex(16)
    challenge = dict(challenge_id=cid, challenge=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('='),
                     rp_id='localhost', action_sha=action_sha, action=operation, subject=subject,
                     tok_id=info['tok_id'], created_at=now(), consumed=False, **extra)
    save(con, 'challenge:' + cid, challenge)
    return {k: challenge[k] for k in ('challenge_id', 'challenge', 'rp_id', 'action_sha')}


def action_challenge(obj):
    info = identity()
    reviewer.require_trust()
    result = {}
    def build(con):
        reviewer.require_trust()
        action = owned(con, obj.get('action_id'), info)
        if action['state'] == 'preparing':
            fail('write_in_flight', 409)
        if action['state'] != 'ready':
            fail('review_stale', 409)
        operation = obj.get('action')
        if operation not in (action['action'], 'publish_external_refine'):
            fail('schema_invalid', 400)
        if operation == 'publish_external_refine' and action['external_refine']['status'] != 'consent_required':
            fail('external_consent_required', 403)
        result.update(issue(con, action['action_id'], operation, binding(action, operation), info))
        return []
    transaction(build)
    return result


def proof(con, obj, subject, operation, action_sha, info):
    challenge = load(con, 'challenge:' + str(obj.get('challenge_id')))
    if (not challenge or challenge['consumed'] or challenge['tok_id'] != info['tok_id']
            or challenge['subject'] != subject or challenge['action'] != operation
            or now() - challenge['created_at'] >= 120):
        fail('review_unverified', 403)
    if challenge['action_sha'] != action_sha:
        fail('review_stale', 409)
    assertion = obj.get('assertion')
    if not isinstance(assertion, dict):
        fail('review_unverified', 403)
    credential = assertion.get('credential_id') or assertion.get('id')
    counter = load(con, 'counter:' + str(credential)) or 0
    credential, new_counter = reviewer.verify(assertion, challenge, counter)
    challenge['consumed'] = True
    save(con, 'challenge:' + challenge['challenge_id'], challenge)
    save(con, 'counter:' + credential, new_counter)
    return dict(action_sha=action_sha, cred_id=credential, assertion_sha=digest(assertion))


def audit(action, operation, proof_value, key, result_sha):
    # extract.run is the existing auditable local/LLM operation event family.
    payload = dict(action_id=action['action_id'], action=operation, prior_state=action['state'],
                   result_sha=result_sha, **proof_value, window_sha=action['_source_sha'], para_shas=[],
                   prompt_version='publish-consent-v1', model=(action.get('engine') or {}).get('model') or 'local',
                   output_sha=result_sha)
    return dict(kind='extract.run', origin='first_party', actor='user:sagae',
                generated_by='app:' + action['label'] + ':action', subject=action['target'], idem_key=key, payload=payload)


def execute(aid, obj, external=False):
    info = identity()
    reviewer.require_trust()
    operation = 'publish_external_refine' if external else None
    namespace = key_for(info, obj.get('idempotency_key'), 'external' if external else 'execute')
    outcome = {}
    queued = []
    def build(con):
        reviewer.require_trust()
        action = owned(con, aid, info)
        replay = load(con, namespace)
        if replay:
            if replay['action_id'] != aid:
                fail('idem_conflict', 409)
            outcome.update(replay['response'])
            return []
        op = operation or action['action']
        if external and not obj.get('assertion'):
            fail('external_consent_required', 403)
        # A previously consumed proof cannot authorize another action/send.
        supplied = load(con, 'challenge:' + str(obj.get('challenge_id')))
        if supplied and (supplied['consumed'] or supplied['subject'] != aid or supplied['action'] != op):
            fail('review_unverified', 403)
        if action['state'] == 'preparing':
            fail('write_in_flight', 409)
        if action['state'] != 'ready':
            fail('review_stale', 409)
        verified = proof(con, obj, aid, op, binding(action, op), info)
        if external:
            if action['external_refine']['status'] != 'consent_required':
                fail('external_consent_required', 403)
            event = audit(action, op, verified, namespace, digest(action['_request'].encode('utf-8')))
            action['_consent_sha'] = binding(action, op)
            action.update(state='preparing', refinement_mode='external_consented', _phase_at=now())
            action['_generation'] += 1
            # The accepted binding predates the generation transition.
            action['_consented_generation'] = action['_generation']
            action['external_refine']['status'] = 'consented'
            action['candidates'] = []
            queued.append(aid)
            outcome.update(status=202, body=dict(action_id=aid, state='preparing'))
            events = [event]
        else:
            version, original = visibility(con, action)
            events, result_ids = [], []
            if action['action'] == 'publish':
                for index, candidate in enumerate(action['candidates']):
                    rid = record.derive_id(namespace + ':' + str(index))
                    value = dict(candidate, id=rid, sensitivity='internal')
                    value.pop('body_sha', None)
                    payload = record.build_payload(value, rid, [], scan=True)
                    if payload['sensitivity'] != 'internal':
                        fail('secret_detected', 403)
                    events.append(dict(kind='record.put', actor='user:sagae', origin='first_party', subject=rid,
                                       generated_by='app:' + info['label'] + ':action', idem_key=namespace + ':record:' + str(index),
                                       payload=payload))
                    events.append(dict(kind='edge.put', actor='user:sagae', origin='first_party', subject=None,
                                       generated_by='app:' + info['label'] + ':action', idem_key=namespace + ':edge:' + str(index),
                                       payload=dict(id=ids.edge_id(rid, 'PROMOTED_FROM', aid), src=rid, dst=action['target'],
                                                    rtype='PROMOTED_FROM', props={'review_action': aid})))
                    result_ids.append(rid)
            else:
                payload = copy.deepcopy(original)
                if action['action'] == 'release':
                    props = payload.setdefault('props', {})
                    payload['sensitivity'] = props.get('quarantine_from', 'internal')
                    for field in ('quarantine', 'quarantine_from', 'quarantine_rules'):
                        props.pop(field, None)
                else:
                    payload['sensitivity'] = action['_sensitivity']
                events.append(dict(kind='record.put', actor='user:sagae', origin='first_party', subject=action['target'],
                                   generated_by='app:' + info['label'] + ':action', idem_key=namespace + ':record',
                                   expected_version=version, payload=payload))
                result_ids.append(action['target'])
            result = dict(ids=result_ids)
            proof_event = audit(action, op, verified, namespace + ':proof', digest(result))
            proof_event['payload']['result'] = result
            proof_event['payload']['published_payload_shas'] = {
                e['subject']: digest(engine.storage_payload(e['payload']))
                for e in events if e['kind'] == 'record.put'}
            events.append(proof_event)
            action.update(state='expired', executed=True, result=result)
            wipe(action)
            outcome.update(status=200, body=dict(action_id=aid, result=result))
        save(con, 'action:' + aid, action)
        save(con, namespace, dict(action_id=aid, response=outcome))
        return events
    transaction(build)
    for queued_id in queued:
        submit(lambda aid=queued_id: run_external(aid))
    return outcome['status'], outcome['body']


def run_external(aid):
    reservation = None
    try:
        _runtime['before_external_send']()
        transport_data = {}
        def reserve(con):
            nonlocal reservation
            reviewer.require_trust()
            action = load(con, 'action:' + aid)
            if action is None:
                return []
            refresh(con, action)
            if action['state'] != 'preparing' or action.get('_sent'):
                return []
            prior_generation = action['_generation']
            action['_generation'] -= 1
            actual = binding(action, 'publish_external_refine')
            action['_generation'] = prior_generation
            if actual != action['_consent_sha']:
                fail('review_stale', 409)
            request = action['_request'].encode('utf-8')
            if secrets_scan.scan_text(request.decode('utf-8')):
                fail('secret_detected', 403)
            if not _runtime['external_transport'] or not _runtime['reserve_external']:
                fail('external_consent_required', 403)
            reservation = _runtime['reserve_external'](action_id=aid, engine=action['_selection']['backend'],
                                                       model=action['_selection']['model'])
            action['_sent'] = True
            save(con, 'action:' + aid, action)
            transport_data.update(request=request, selection=action['_selection'], phase_at=action['_phase_at'])
            return []
        transaction(reserve)
        if not transport_data:
            return
        selection = transport_data['selection']
        try:
            result = _runtime['external_transport'](transport_data['request'], engine=selection['backend'],
                                                     model=selection['model'], max_retries=0)
        except Exception:
            reservation['state'] = 'uncertain'
            mark_failed(aid, 'external_uncertain')
            return
        ready_candidates = candidates_from(result)
        def complete(con):
            action = load(con, 'action:' + aid)
            if action is None:
                return []
            refresh(con, action)
            if action['state'] != 'preparing':
                reservation['state'] = 'uncertain'
                return []
            action.update(state='ready', candidates=ready_candidates, expires_at=now() + 900,
                          engine=result['engine'], cost_usd=result.get('cost_usd'),
                          duration_ms=int((now() - transport_data['phase_at']) * 1000) + result.get('duration_ms', 0))
            _capacity(con, action)
            save(con, 'action:' + aid, action)
            reservation['state'] = 'settled'
            return []
        transaction(complete)
    except (WriteRejected, ValueError, KeyError, OSError):
        if reservation is not None:
            reservation['state'] = 'uncertain'
        mark_failed(aid, 'external_failed')


def update_candidate(aid, index, **changes):
    """Internal worker persistence port; never dispatched from client fields."""
    def build(con):
        action = load(con, 'action:' + aid)
        action['candidates'][index].update(changes)
        save(con, 'action:' + aid, action)
        return []
    transaction(build)


def update_external_plan(aid, **changes):
    def build(con):
        action = load(con, 'action:' + aid)
        if 'request_bytes' in changes:
            action['_request'] = changes['request_bytes'].decode('utf-8')
        for field, dest in (('engine', 'backend'), ('model', 'model')):
            if field in changes:
                action['_selection'][dest] = changes[field]
        save(con, 'action:' + aid, action)
        return []
    transaction(build)


def reconcile_hitl(signal):
    result = {}
    def build(con):
        kind = signal['kind']
        if kind not in KINDS:
            return []
        item_id = 'h-' + digest([kind, signal['target'], signal['verdict']])[:32]
        prior = load(con, 'hitl:' + item_id)
        if not signal.get('unresolved'):
            if prior:
                prior['state'] = 'auto_resolved'
                save(con, 'hitl:' + item_id, prior)
                result.update(prior)
            return []
        if prior is None:
            prior = dict(signal, id=item_id, state='open', created_at=now(), proposed_state=signal.get('proposed_state'))
            save(con, 'hitl:' + item_id, prior)
        save(con, 'verdict:' + digest([kind, signal['target']]), signal['verdict'])
        result.update(prior)
        return []
    transaction(build)
    return result


def get_hitl(item_id):
    with database() as con:
        value = load(con, 'hitl:' + item_id)
        if value is None:
            fail('not_found', 404)
        return value


def list_hitl(kind=None):
    identity()
    reviewer.require_trust()
    with database() as con:
        items = []
        for _, value in rows(con, 'hitl:'):
            if value['state'] != 'open' or (kind is not None and value['kind'] != kind):
                continue
            if value['target'].startswith('f-'):
                try:
                    source(con, value['target'])
                except WriteRejected:
                    continue
            item = copy.deepcopy(value)
            item['created_at'] = public_time(item['created_at'])
            items.append(item)
        return items


def target_revision(con, target):
    row = con.execute("SELECT seq,payload_sha FROM event WHERE subject=? AND kind IN "
                      "('record.put','record.tombstone','record.redact','claim.assert','claim.review','survival.verdict') "
                      "ORDER BY seq DESC LIMIT 1", (target,)).fetchone()
    return list(row) if row else None


def hitl_challenge(obj):
    info = identity()
    reviewer.require_trust()
    result = {}
    def build(con):
        reviewer.require_trust()
        item = load(con, 'hitl:' + str(obj.get('item')))
        if not item or item['state'] != 'open':
            fail('review_stale', 409)
        if item['verdict'] != load(con, 'verdict:' + digest([item['kind'], item['target']])):
            fail('review_stale', 409)
        bound = dict(item=item['id'], verdict=item['verdict'], state=item['state'],
                     action=obj.get('action'), params=obj.get('params', {}),
                     target_revision=target_revision(con, item['target']))
        result.update(issue(con, item['id'], obj.get('action'), digest(bound), info,
                            target_revision=bound['target_revision']))
        return []
    transaction(build)
    return result


def resolve_hitl(item_id, obj):
    info = identity()
    reviewer.require_trust()
    result = {}
    namespace = key_for(info, obj.get('idempotency_key'), 'hitl')
    def build(con):
        reviewer.require_trust()
        item = load(con, 'hitl:' + item_id)
        if not item:
            fail('not_found', 404)
        replay = load(con, namespace)
        if replay:
            result.update(replay)
            return []
        if item['state'] != 'open' or item['verdict'] != load(con, 'verdict:' + digest([item['kind'], item['target']])):
            fail('review_stale', 409)
        bound = dict(item=item_id, verdict=item['verdict'], state=item['state'],
                     action=obj.get('action'), params=obj.get('params', {}),
                     target_revision=target_revision(con, item['target']))
        challenge = load(con, 'challenge:' + str(obj.get('challenge_id')))
        if challenge and challenge.get('target_revision') != bound['target_revision']:
            fail('review_stale', 409)
        # Altering action/params is a wrong proof, not a new target version.
        if challenge and (challenge['action'] != obj.get('action') or challenge['action_sha'] != digest(bound)):
            fail('review_unverified', 403)
        verified = proof(con, obj, item_id, obj.get('action'), digest(bound), info)
        if item['kind'] != 'gate_unresolved' or obj.get('action') not in ('accept', 'reject'):
            fail('review_unverified', 403)
        state = 'user_accepted' if obj['action'] == 'accept' else 'user_rejected'
        previous = con.execute("SELECT payload_sha FROM event WHERE subject=? AND kind='claim.assert' ORDER BY seq DESC LIMIT 1",
                               (item['target'],)).fetchone()
        if previous is None:
            fail('not_found', 404)
        original = ledger.get_payload(con, previous[0])
        payload = dict(id=item['target'], verification=original['verification'], decided_by='user:sagae',
                       review_state=state, item=item_id, action=obj['action'], prior_state=item['state'], **verified)
        item['state'] = 'resolved'
        save(con, 'hitl:' + item_id, item)
        save(con, 'claim-review:' + item['target'], state)
        result.update(item=item_id, review_state=state)
        save(con, namespace, result)
        return [dict(kind='claim.review', actor='user:sagae', origin='first_party', subject=item['target'],
                     generated_by='app:' + info['label'] + ':hitl', idem_key=namespace, payload=payload)]
    transaction(build)
    return result


def enroll(obj):
    identity()
    reviewer.require_trust(require_registered=False)
    if obj.get('rp_id') != 'localhost' or obj.get('origin') != 'http://localhost:4812':
        fail('review_unverified', 403)
    request_id = 'reg-' + secrets.token_hex(16)
    def build(con):
        save(con, 'enroll:' + request_id, {k: obj[k] for k in ('rp_id', 'origin', 'credential_id', 'public_key')})
        return []
    transaction(build)
    return dict(request_id=request_id)
