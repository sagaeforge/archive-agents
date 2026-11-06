"""ADR-0004 E1: jobs select API engines; no subscription preflight or canary."""
import json

import pytest

from arhelp import approve
from kb.commands import jobs
from kb.extract import budget, engines, guard, route, settings, state


def fund(home):
    budget.set_balance(100.)
    state.put('credit:anthropic_api', credit())


def credit(**kw):
    return dict(dict(balance=200., budget_usd=200., cycle_spent=0., spent_today=0., reserved=0., cap_today=60.), **kw)


@pytest.fixture(autouse=True)
def funding(home):
    fund(home)
    with settings.override(**{'selector.epsilon': 0, 'openrouter.daily_valve_usd': 60.}):
        yield


def fake_cli(home, *, cost=.25, source='apiKeyHelper', crash=False):
    import sys
    from pathlib import Path
    src = str(Path(__file__).resolve().parents[2] / 'src')
    fake = home / 'fake-claude'
    fake.write_text(f'''#!{sys.executable}
import json,os,sys,subprocess,shlex
sys.path.insert(0, {src!r})
from kb.extract import budget,state
if 'auth' in sys.argv:
    print(json.dumps({{'authMethod':'api_key','apiKeySource':'apiKeyHelper'}}))
    sys.exit(0)
settings=json.load(open(sys.argv[sys.argv.index('--settings')+1]))
assert settings.get('disableAllHooks') is True
assert sys.argv[sys.argv.index('--setting-sources')+1] == ''
assert '--strict-mcp-config' in sys.argv
with open({str(home / 'paid.jsonl')!r}, 'a') as f:
    f.write(json.dumps({{'reserved':budget.day()['reserved'], 'env':dict(os.environ), 'argv':sys.argv, 'admissions':[state.get(k) for k in state.keys('llm:reservation:')]}})+'\\n')
subprocess.run([sys.executable, '-c', 'import os,json;open('+repr({str(home / 'descendant.json')!r})+',"w").write(json.dumps(dict(os.environ)))'], check=True)
if '--mcp-config' in sys.argv:
    mcp=json.load(open(sys.argv[sys.argv.index('--mcp-config')+1]))['mcpServers']
    assert list(mcp)==['kb-collect']
    srv=mcp['kb-collect']
    subprocess.run([srv['command'],*srv['args']],env=dict(os.environ,ANTHROPIC_API_KEY='injected-fixture-key',OPENAI_API_KEY='injected-fixture-key'),check=True)
key=subprocess.run(shlex.split(settings['apiKeyHelper']),capture_output=True,text=True,check=True).stdout.strip()
print(json.dumps({{'type':'system','subtype':'init','apiKeySource':{source!r}}}),flush=True)
if {crash!r}:
    sys.exit(7)
print(json.dumps({{'type':'result','is_error':False,'subtype':'success','total_cost_usd':{cost!r},'result':key}}),flush=True)
''')
    fake.chmod(0o700)
    server = home / 'runtime' / 'bin' / 'kb-mcp'
    server.parent.mkdir(parents=True, exist_ok=True)
    server.write_text(f'''#!{sys.executable}
import os,json
open({str(home / 'mcp-env.json')!r},'w').write(json.dumps(dict(os.environ)))
''')
    server.chmod(0o700)
    return fake


def key(home, engine):
    p = home / 'config' / engines.KEY_FILES[engine]
    p.write_text('fixture-redaction-key')
    p.chmod(0o600)


@pytest.fixture
def env(home, monkeypatch):
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    monkeypatch.setattr(jobs, 'load_agent_jobs', lambda: [
        {'id': 'a', 'cmd': 'kb-agent-run kb-fulfill'}, {'id': 'b', 'cmd': 'kb-agent-run kb-retro'}])
    monkeypatch.setenv('KB_AGENT_RUN', str(__import__('pathlib').Path(__file__).resolve().parents[2] / 'ops/bin/kb-agent-run'))
    # Real selector, wrapper, reservation, settlement and subprocesses; no paid calls.
    return home


def paid(home):
    p = home / 'paid.jsonl'
    return [json.loads(s) for s in p.read_text().splitlines()] if p.exists() else []


def test_jobs_pass_engine_on_every_invocation(env):
    out = jobs.run_due()
    assert len(paid(env)) == 2
    assert [x['reserved'] for x in paid(env)] == [2., 1.]
    assert budget.day()['spent'] == .5 and budget.day()['reserved'] == 0
    assert budget.balance() == 99.5
    assert all(r['engine'] == 'openrouter' for r in out['ran'])


def test_existing_global_stop_is_respected_without_canary(env, monkeypatch):
    state.put(route.STOP_KEY, {'reason': 'incident_1'})
    monkeypatch.setattr(route, 'claude_rate', lambda *a: pytest.fail('subscription canary'))
    out = jobs.run_due()
    assert not paid(env) and set(out['skipped'].values()) == {'engine_hold_incident_1'}


def test_overage_leaves_api_jobs_available(env):
    route.apply('claude_overage', isUsingOverage=True)
    assert jobs.run_due()['calls'] == 2 and len(paid(env)) == 2
    assert route.stopped() is None and not route.is_off('openrouter')


def test_gate_is_rechecked_for_each_job(env, monkeypatch):
    real = jobs.subprocess.run
    def run(argv, **kw):
        result = real(argv, **kw)
        route.set_off('openrouter', 'auth_signature', None)
        return result
    monkeypatch.setattr(jobs.subprocess, 'run', run)
    out = jobs.run_due()
    assert out['calls'] == 1 and out['skipped']['b'] == 'no_api_engine'


def test_no_available_engine_is_queued(env, monkeypatch):
    monkeypatch.setattr(jobs, '_engine_for', lambda j: None)
    assert set(jobs.run_due()['skipped'].values()) == {'no_api_engine'} and not paid(env)


def test_dry_run_has_engine_and_makes_zero_calls(env):
    out = jobs.run_due(dry_run=True)
    assert len(out['ran']) == 2 and not paid(env)
    assert all(r['engine'] != 'claude_sub' for r in out['ran'])


def test_configured_subscription_engine_rejected(home):
    assert jobs._engine_for({'cmd': 'kb retro', 'engine': 'claude_sub'}) is None


def test_api_auth_signatures_are_required():
    assert engines.auth_signature('anthropic_api', {'authMethod': 'api_key'})
    assert not engines.auth_signature('anthropic_api', {'authMethod': 'oauth_token'})
    assert not engines.auth_signature('openrouter', {'authMethod': 'claude.ai'})
    assert engines.auth_signature('openrouter', {'apiKeySource': 'ANTHROPIC_AUTH_TOKEN'}, phase='init')
    assert not engines.auth_signature('openrouter', {'apiKeySource': '/login managed key'}, phase='init')
    assert not engines.auth_signature('anthropic_api', {}, phase='init')


def test_isolated_api_environment_and_redacted_preview(home, monkeypatch):
    from kb.agentrun import auth, invoke
    secret = 'fixture-api-key'
    for engine in ('openrouter', 'anthropic_api'):
        p = home / 'config' / engines.KEY_FILES[engine]
        p.write_text(secret)
        p.chmod(0o600)
        call = invoke.build('kb-fulfill', str(home), engine=engine,
                            environ={'HOME': str(home), 'OPENAI_API_KEY': 'inherited', 'ANTHROPIC_AUTH_TOKEN': 'inherited'})
        assert secret not in call.shell() and secret not in repr(call)
        with auth.environment(engine, call.env) as (e, key):
            from pathlib import Path
            assert key == secret and e['HOME'] != str(home)
            assert e['CLAUDE_CONFIG_DIR'] == e['HOME']
            assert not (Path(e['HOME']) / '.credentials.json').exists()
            assert 'OPENAI_API_KEY' not in e
            assert secret not in e.values()
            assert not {'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'} & e.keys()
            doc = json.loads(__import__('pathlib').Path(e['KB_API_SETTINGS']).read_text())
            assert doc['disableAllHooks'] is True and secret not in json.dumps(doc)


def test_agent_requires_explicit_engine(home):
    from kb.agentrun import invoke
    with pytest.raises(ValueError, match='explicit_api_engine_required'):
        invoke.build('kb-fulfill', str(home))


@pytest.mark.parametrize('engine', ['openrouter', 'anthropic_api'])
def test_runner_auth_and_secret_redaction(home, monkeypatch, capsys, engine):
    from kb.agentrun import runner
    from kb.metrics.retro import _read_archive
    approve(home, 11)
    secret = 'fixture-redaction-key'
    key(home, engine)
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    assert runner.main(['kb-retro', '--engine', engine]) == 0
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    out = json.loads(captured.out)
    events = _read_archive(out['archive'])
    assert secret not in json.dumps(events) and '<redacted>' in json.dumps(events)


def test_runner_signature_mismatch_only_disables_selected_engine(home, monkeypatch, capsys):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, 'anthropic_api')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home, source='/login managed key')))
    assert runner.main(['kb-retro', '--engine', 'anthropic_api']) == 1
    assert route.is_off('anthropic_api') and not route.is_off('openrouter')
    assert route.stopped() is None
    assert 'auth_signature' in capsys.readouterr().out


@pytest.mark.parametrize('cmd', ['claude -p hello', 'codex exec hello', 'env claude -p hello'])
def test_raw_subscription_commands_cannot_bypass_selector(home, cmd):
    assert jobs._engine_for({'cmd': cmd}) is None


def test_sensitive_job_selects_local_without_api_key(home):
    assert jobs._engine_for({'cmd': 'kb agent run --scope sensitive'}) == 'local'


@pytest.mark.parametrize('engine', ['openrouter', 'anthropic_api'])
def test_workflow_reserves_and_settles_shared_ledger(home, monkeypatch, engine):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, engine)
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    assert runner.main(['kb-fulfill', '--engine', engine]) == 0
    assert paid(home)[0]['reserved'] == 2.
    assert budget.day()['spent'] == .25 and budget.day()['reserved'] == 0
    if engine == 'openrouter':
        assert budget.balance() == 99.75
    else:
        assert state.get('credit:anthropic_api')['cycle_spent'] == .25
        assert state.get('credit:anthropic_api')['balance'] == 199.75
    # An extraction reservation shares the exact same daily record.
    reservation = budget.reserve(.1, model="openai/gpt-6.1-sol")
    assert budget.day()['spent'] == .25 and budget.day()['reserved'] == .1
    budget.release(reservation)


def test_jobs_refuse_5999_valve_without_credit_state(env):
    state.put(budget.day_key(), dict(spent=59.99, reserved=0.))
    assert state.get('credit:openrouter') is None
    out = jobs.run_due()
    assert not paid(env) and out['calls'] == 0
    assert set(out['skipped'].values()) == {'no_api_engine'}
    assert budget.day()['spent'] == 59.99


@pytest.mark.parametrize('engine', ['openrouter', 'anthropic_api'])
@pytest.mark.parametrize('control', ['llm_off', 'credit_off', 'pace_off', 'model_hold', 'canonical_model_hold',
    'arm_hold', 'enabled', 'day_cap', 'cycle_cap', 'target', 'balance', 'missing', 'incomplete', 'valve', 'pace_day_cap', 'pace_cycle_cap'])
def test_direct_workflow_honors_every_disable_control(home, monkeypatch, engine, control):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, engine)
    model = 'anthropic/claude-haiku-5.5' if engine == 'openrouter' else 'haiku'
    changes = {}
    if control == 'llm_off':
        route.set_off(engine, 'test', None)
    elif control == 'credit_off':
        state.put('credit:off:' + engine, {'reason': 'test'})
    elif control == 'pace_off':
        changes[f'engines.{engine}.pace.mode'] = 'off'
    elif control == 'pace_day_cap':
        changes[f'engines.{engine}.pace.cap_day_usd'] = 1.
    elif control == 'pace_cycle_cap':
        changes[f'engines.{engine}.pace.budget_usd'] = 1.
    elif control == 'enabled':
        changes[f'engines.{engine}.enabled'] = False
    elif control in ('model_hold', 'canonical_model_hold'):
        route.set_off(route.model_key(engine, model) if control == 'model_hold' else f'{engine}:{model}', 'test', None)
    elif control == 'arm_hold':
        state.put(f'arm:off:agent:{engine}:{model}', {'reason': 'test'})
    elif control == 'missing':
        state.delete(budget.BAL if engine == 'openrouter' else 'credit:' + engine)
    elif control == 'incomplete':
        state.put('credit:' + engine, {})
    elif control == 'valve':
        state.put(budget.day_key(), dict(spent=59.99, reserved=0.))
    else:
        values = credit()
        if control == 'day_cap': values['cap_today'] = 1.
        if control == 'cycle_cap': values['cycle_spent'] = 199.
        if control == 'target': values['target_today'] = 1.
        if control == 'balance': values['balance'] = 1.
        state.put('credit:' + engine, values)
    monkeypatch.setattr(__import__('kb.agentrun.auth', fromlist=['preflight']), 'preflight',
                        lambda *a: pytest.fail('disabled engine reached CLI authentication'))
    with settings.override(**changes):
        assert runner.main(['kb-fulfill', '--engine', engine]) == 3
    assert not paid(home)


@pytest.mark.parametrize('engine', ['openrouter', 'anthropic_api'])
def test_descendants_never_inherit_credential_and_project_hooks_are_disabled(home, monkeypatch, engine):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, engine)
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'inherited-secret')
    monkeypatch.setenv('OPENAI_API_KEY', 'inherited-secret')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    assert runner.main(['kb-fulfill', '--engine', engine]) == 0
    for name in ('descendant.json', 'mcp-env.json'):
        doc = json.loads((home / name).read_text())
        assert not {'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'} & doc.keys()
        assert not {'fixture-redaction-key', 'inherited-secret', 'injected-fixture-key'} & set(doc.values())
    cli = paid(home)[0]
    assert 'fixture-redaction-key' not in json.dumps(cli)


def test_workflow_crash_charges_full_reservation(home, monkeypatch):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home, crash=True)))
    assert runner.main(['kb-fulfill', '--engine', 'openrouter']) == 1
    assert budget.day()['spent'] == 2. and budget.day()['reserved'] == 0
    assert budget.balance() == 98.


def test_failed_spawn_releases_reservation(home, monkeypatch):
    from kb.agentrun import runner
    from kb.agentrun import auth
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setenv('KB_CLAUDE_BIN', '/nonexistent/claude')
    monkeypatch.setattr(auth, 'preflight', lambda *a: True)
    with pytest.raises(OSError):
        runner.main(['kb-fulfill', '--engine', 'openrouter'])
    assert budget.day()['spent'] == 0 and budget.day()['reserved'] == 0


def test_competing_reservations_are_atomic(home):
    from concurrent.futures import ThreadPoolExecutor
    def attempt(_):
        try:
            return budget.reserve(.6, model="openai/gpt-6.1-sol")
        except budget.Refused:
            return None
    with settings.override(**{'openrouter.daily_valve_usd': 1.}):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(8)))
    admitted = [r for r in results if r]
    assert len(admitted) == 1 and budget.day()['reserved'] == .6
    assert not budget.settle(admitted[0], .4)
    assert not budget.settle(admitted[0], .4)  # duplicate completion cannot charge twice
    assert budget.day()['spent'] == .4 and budget.day()['reserved'] == 0


def test_engine_balances_are_independent_but_valve_is_shared(home):
    budget.set_balance(1.)
    anthropic = budget.reserve(2., engine='anthropic_api', purpose='agent', model="openai/gpt-6.1-sol")
    openrouter = budget.reserve(.2, purpose='agent', model="openai/gpt-6.1-sol")
    assert budget.day()['reserved'] == 2.2
    budget.settle(anthropic, .5)
    budget.settle(openrouter, .1)
    assert budget.balance() == .9
    assert state.get('credit:anthropic_api')['balance'] == 199.5
    assert budget.day()['spent'] == .6 and budget.day()['reserved'] == 0


@pytest.mark.parametrize('value', [0, -1, float('nan'), float('inf')])
def test_invalid_reservation_never_launches_paid_workflow(home, monkeypatch, value):
    from kb.agentrun import runner
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    assert runner.main(['kb-fulfill', '--engine', 'openrouter', f'--max-budget-usd={value}']) == 3
    assert not paid(home)


def test_preflight_failure_leaves_no_reservation_or_spend(home, monkeypatch):
    from kb.agentrun import auth, runner
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setattr(auth, 'preflight', lambda *a: False)
    assert runner.main(['kb-fulfill', '--engine', 'openrouter']) == 3
    assert budget.day()['reserved'] == 0 and budget.day()['spent'] == 0


@pytest.mark.parametrize('hold', ['engine', 'model', 'global', 'guard'])
def test_hold_applied_during_preflight_prevents_paid_spawn(home, monkeypatch, hold):
    from kb.agentrun import auth, runner
    approve(home, 11)
    key(home, 'openrouter')
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    def preflight(*a):
        if hold == 'engine': route.set_off('openrouter', 'test', None)
        elif hold == 'model': route.set_off('anthropic/claude-haiku-5.5', 'test', None)
        elif hold == 'global': state.put(route.STOP_KEY, {'reason': 'test'})
        else: state.put(guard.HALT_KEY, {'reason': 'test'})
        return True
    monkeypatch.setattr(auth, 'preflight', preflight)
    assert runner.main(['kb-fulfill', '--engine', 'openrouter']) == 3
    assert not paid(home) and budget.day()['reserved'] == 0
