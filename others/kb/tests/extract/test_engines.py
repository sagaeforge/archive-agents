"""E1 security boundaries and measured arm selection: no paid calls."""
import itertools
import json
import random

import pytest

from kb.extract import engines as E, llmhttp, route, settings, state


def test_automatic_selector_never_accepts_subscription(env):
    arms = [E.Arm('agent', e, 'm') for e in ['claude_sub', 'claude', 'codex', *E.AUTO_ENGINES]]
    for flags in itertools.product([False, True], repeat=4):
        allowed = dict(zip(sorted(E.AUTO_ENGINES), flags))
        chosen = E.select('agent', arms, eligible=lambda a: allowed.get(a.engine, True), rng=random.Random(1))
        assert chosen is None or chosen.engine in E.AUTO_ENGINES


@pytest.mark.parametrize('task', sorted(E.LOCAL_TASKS))
def test_no_external_task_uses_local(env, task):
    arms = [E.Arm(task, e, 'm') for e in E.AUTO_ENGINES]
    assert E.select(task, arms, eligible=lambda a: True).engine == 'local'


def test_no_external_flag_uses_local(env):
    arms = [E.Arm('agent', e, 'm') for e in E.AUTO_ENGINES]
    assert E.select('agent', arms, needs_external=False, eligible=lambda a: True).engine == 'local'


def test_overage_does_not_write_any_stop_or_off(env):
    state.put(route.STOP_KEY, {'reason': 'existing_incident'})
    route.set_off('openai_api', 'existing_manual', None)
    before = {k: state.get(k) for k in state.keys('llm:')}
    v = route.apply('claude_overage', isUsingOverage=True)
    assert v.target == 'claude_sub' and not v.fallthrough
    assert {k: state.get(k) for k in state.keys('llm:')} == before
    assert len(state.metrics('claude.overage_seen')) == 1


def test_one_engine_hold_leaves_others_available(env):
    from kb.extract import budget
    budget.set_balance(100.)
    route.set_off('anthropic_api', 'auth_signature', None)
    for engine in E.AUTO_ENGINES:
        assert E.available(E.Arm('agent', engine, 'm'), authenticate=False) == (engine != 'anthropic_api')


@pytest.mark.parametrize('url', ['https://evil.test/v1', 'https://openrouter.ai.evil.test',
    'https://openrouter.ai@evil.test', 'https://openrouter.ai:444/api', 'http://api.openai.com',
    'https://api.openai.com/#secret'])
def test_host_allowlist_rejects_unlisted_without_echoing_url(url):
    with pytest.raises(ValueError) as exc:
        llmhttp._check(url)
    assert url not in str(exc.value)


@pytest.mark.parametrize('url', ['https://openrouter.ai/api', 'https://api.openai.com/v1',
    'https://api.anthropic.com/v1', 'http://127.0.0.1:1234', 'http://[::1]:1234'])
def test_allowed_hosts(url):
    llmhttp._check(url)


def test_per_engine_host_signature():
    with pytest.raises(E.AuthError):
        E.check_host('openai_api', 'https://api.anthropic.com/v1')


@pytest.mark.parametrize('engine', sorted(E.API_ENGINES))
def test_secret_never_in_error_or_logs(env, engine, capsys):
    secret = 'fixture-secret-do-not-log'
    p = env.cfg / E.KEY_FILES[engine]
    p.write_text(secret)
    p.chmod(0o644)
    with pytest.raises(E.AuthError) as exc:
        E.read_key(engine)
    assert secret not in str(exc.value)
    p.chmod(0o600)
    assert E.read_key(engine) == secret
    assert secret not in E.redact('failure: ' + secret, (secret,))
    assert secret not in ''.join(capsys.readouterr())


def test_arm_quality_and_monthly_credit_lag(env):
    arms = [E.Arm('extract', e, 'm') for e in ['openrouter', 'openai_api', 'anthropic_api']]
    for arm in arms:
        for _ in range(200):
            E.record(arm, cost=.1, accepted=9, rejected=1)
    state.put('credit:openai_api', {'planned_spend': 50, 'cycle_spent': 10})
    state.put('credit:anthropic_api', {'planned_spend': 50, 'cycle_spent': 40})
    with settings.override(**{'selector.epsilon': 0}):
        assert E.select('extract', arms, eligible=lambda a: True).engine == 'openai_api'
    bad = arms[1]
    for _ in range(200):
        E.record(bad, cost=.001, accepted=1, rejected=9)
    assert E.score(bad)['score'] == 0 and len(state.get(bad.key)) == 200
    with settings.override(**{'selector.epsilon': 0}):
        assert E.select('extract', arms, eligible=lambda a: True).engine == 'anthropic_api'


def test_exploration_chooses_least_sampled(env):
    a, b = E.Arm('agent', 'openrouter', 'a'), E.Arm('agent', 'anthropic_api', 'b')
    E.record(a, accepted=1, cost=1.)
    with settings.override(**{'selector.epsilon': 1}):
        assert E.select('agent', [a, b], eligible=lambda a: True) == b


def test_disabled_pace_credit_and_arms_not_selected(env):
    arm = E.Arm('agent', 'openai_api', 'm')
    with settings.override(**{'engines.openai_api.pace.mode': 'off'}):
        assert not E.available(arm, authenticate=False)
    state.put('credit:openai_api', {'cap_today': 5, 'spent_today': 4, 'reserved': 1})
    assert not E.available(arm, authenticate=False)


def test_codex_environment_has_zero_openai_keys(env, monkeypatch):
    from kb.extract.backends.codex import _env, build_cmd
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ADMIN_KEY'):
        monkeypatch.setenv(key, 'secret')
    assert not any(k.startswith(('OPENAI_', 'CODEX_API_')) for k in _env())
    assert _env()['CODEX_HOME'].endswith('/codex-home')
    assert 'forced_login_method="chatgpt"' in build_cmd('m', 'schema', 'out', 'work')


def test_automatic_packages_do_not_import_subscription_adapter():
    import ast
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / 'src/kb'
    for p in [root / 'commands/jobs.py', root / 'metrics/retro.py', *list((root / 'agentrun').glob('*.py')),
              root / 'extract/route.py', root / 'extract/runner.py', root / 'extract/support.py']:
        for node in ast.walk(ast.parse(p.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert node.module != 'kb.extract.backends.claude', p


@pytest.mark.parametrize('failure', ['body', 'exception', 'http'])
def test_openrouter_error_redacts_key(envk, monkeypatch, failure, capsys):
    import io
    from kb.extract.backends import openrouter
    from kb.extract.types import Job, Window
    secret = E.read_key('openrouter')
    from kb.extract import budget
    budget.set_balance(100.)
    def request(*a, **kw):
        if failure == 'body':
            return {'error': {'message': secret}}
        if failure == 'http':
            raise llmhttp.HTTPError('https://openrouter.ai/api', 401, 'bad', {}, io.BytesIO(secret.encode()))
        raise ValueError('failure ' + secret)
    monkeypatch.setattr(openrouter, '_req', request)
    monkeypatch.setattr(openrouter.guard, 'verify', lambda *a: None)
    job = Job(Window('w', 's', 'text', [], []), 'extract', 'public', 'system', 'user', {}, 'm')
    job.admission = budget.admit('openrouter', job.model, job.purpose, 1., job=job.window.window_id)
    result = openrouter.OpenRouter().extract(job, None)
    assert result.error and secret not in result.error
    assert secret not in ''.join(capsys.readouterr())


def test_monthly_lag_is_relative_to_each_plan(env):
    arms = [E.Arm('extract', e, 'm') for e in ('openai_api', 'anthropic_api')]
    for a in arms:
        E.record(a, cost=.1, accepted=1)
    state.put('credit:openai_api', {'planned_spend': 100, 'cycle_spent': 60})
    state.put('credit:anthropic_api', {'planned_spend': 20, 'cycle_spent': 5})
    assert E.select('extract', arms, eligible=lambda a: True).engine == 'anthropic_api'


def test_router_pins_one_selected_arm(env):
    from . import helpers as H
    from kb.extract import budget
    budget.set_balance(100)
    p = route.Router({'openrouter': H.Fake('openrouter', True), 'anthropic_api': H.Fake('anthropic_api', True)}).plan('public')
    assert len(p.cands) == 1


def test_local_pace_off_leaves_sensitive_work_queued(env):
    with settings.override(**{'engines.local.pace.mode': 'off'}):
        plan = route.Router().plan('sensitive')
    assert not plan.cands and plan.stop == 'local_unavailable'


def test_rate_limit_overage_signal_is_execution_scoped(env, caplog):
    verdict = route.apply('claude_overage', rate_limit_type='overage')
    assert verdict.target == 'claude_sub' and verdict.action == 'halt'
    assert route.stopped() is None and not state.keys('llm:off:')
    assert 'manual execution' in caplog.text


def test_cross_check_never_uses_same_vendor_fallback(env):
    from . import helpers as H
    with settings.override(**{'openrouter.enabled': False}):
        p = route.Router({'anthropic_api': H.Fake('anthropic_api', True)}).plan('public', 'cross', extractor='anthropic/claude-haiku-5.5')
    assert not p.cands


def test_audit_distortion_zeroes_score_without_incrementing_calls(env):
    arm = E.Arm('extract', 'openrouter', 'm')
    E.record(arm, cost=.1, accepted=9, rejected=1)
    assert E.score(arm)['score'] == 90
    E.record_audit(arm, distorted=True)
    assert E.score(arm)['score'] == 0
    assert E.score(arm)['samples'] == 1


@pytest.mark.parametrize('kind,offset', [('http', 195), ('body', 285), ('choice', 285), ('exception', 195), ('partial', 0)])
def test_error_redacts_before_truncation_and_masks_partial_prefixes(envk, monkeypatch, kind, offset):
    import io
    from kb.extract.backends import openrouter
    from kb.extract.types import Job, Window
    secret = E.read_key('openrouter')
    from kb.extract import budget
    budget.set_balance(100.)
    text = 'x' * offset + (secret[:12] if kind == 'partial' else secret) + ' suffix'
    def request(*a, **kw):
        if kind in ('http', 'partial'):
            raise llmhttp.HTTPError('https://openrouter.ai/api', 500, 'bad', {}, io.BytesIO(text.encode()))
        if kind == 'exception':
            raise ValueError(text)
        if kind == 'body':
            return {'error': {'message': text}}
        return {'choices': [{'error': {'message': text}}]}
    monkeypatch.setattr(openrouter, '_req', request)
    monkeypatch.setattr(openrouter.guard, 'verify', lambda *a: None)
    job = Job(Window('w', 's', 'text', [], []), 'extract', 'public', 'sys', 'user', {}, 'm')
    job.admission = budget.admit('openrouter', job.model, job.purpose, 1., job=job.window.window_id)
    result = openrouter.OpenRouter().extract(job, None)
    assert secret not in result.error and secret[:5] not in result.error
    assert not any(result.error.endswith(secret[:n]) for n in range(1, len(secret)))
    assert len(result.error) <= 315
