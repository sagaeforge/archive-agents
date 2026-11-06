"""Admission invariant: cross-date money, capabilities and every paid boundary (no sockets)."""
import ast
import io
import json
from pathlib import Path

import pytest

from kb.extract import budget, guard, llmhttp, paid, route, runner, settings, state, support
from kb.extract.backends.openrouter import OpenRouter
from kb.extract.types import Job, Window
from . import helpers as H

SOL = route.SOL


@pytest.fixture
def funds(env):
    budget.set_balance(100.)
    return env


def at(monkeypatch, value):
    import datetime
    monkeypatch.setenv('KB_EXTRACT_NOW', str(datetime.datetime.fromisoformat(value).timestamp()))


def test_outstanding_survives_midnight_and_reconciliation(funds, monkeypatch):
    budget.set_balance(10.)
    at(monkeypatch, '2026-11-04T23:59:00+09:00')
    token = budget.admit('openrouter', SOL, 'extract', 9.)
    at(monkeypatch, '2026-11-05T00:01:00+09:00')
    assert budget.day()['reserved'] == 0
    with pytest.raises(budget.Refused, match='balance'):
        budget.admit('openrouter', SOL, 'extract', 9.)
    with pytest.raises(budget.Refused, match='evidence'):
        budget.reconcile(token['id'], actual=1., evidence='')
    budget.reconcile(token['id'], actual=1., evidence='provider receipt, operator verified')
    assert budget.balance() == 9.
    assert state.get('llm:reservation:' + token['id']) is None
    assert state.get('llm:reconciled:' + token['id'])['actual'] == 1.
    assert budget.admit('openrouter', SOL, 'extract', 8.8)


def test_all_date_pending_counts_for_daily_valve_and_credit_after_reset(funds, monkeypatch):
    at(monkeypatch, '2026-11-04T23:59:00+09:00')
    token = budget.admit('anthropic_api', 'haiku', 'agent', 9.)
    at(monkeypatch, '2026-11-05T00:01:00+09:00')
    credit = state.get('credit:anthropic_api')
    credit.update(reserved=0., spent_today=0., cycle_spent=0., cap_today=10.)
    state.put('credit:anthropic_api', credit)
    with pytest.raises(budget.Refused, match='credit_cap'):
        budget.admit('anthropic_api', 'haiku', 'agent', 2.)
    with settings.override(**{'openrouter.daily_valve_usd': 10.}):
        with pytest.raises(budget.Refused, match='valve'):
            budget.admit('openrouter', SOL, 'extract', 2.)
    budget.reconcile(token['id'], actual=None, evidence='unknown after crash; charge full reservation')
    assert budget.balance() == 100. and state.get('credit:anthropic_api')['balance'] == 191.


@pytest.mark.parametrize('engine,model', [('openrouter', SOL), ('anthropic_api', 'haiku')])
@pytest.mark.parametrize('completion', ['settle', 'reconcile'])
def test_cross_midnight_settlement_charges_today_without_reopening_cap(
        funds, monkeypatch, engine, model, completion):
    with settings.override(**{'openrouter.daily_valve_usd': 10.}):
        at(monkeypatch, '2026-11-04T23:59:00+09:00')
        token = budget.admit(engine, model, 'extract', 9.)
        at(monkeypatch, '2026-11-05T00:01:00+09:00')
        today_token = budget.admit(engine, model, 'extract', .5)
        with pytest.raises(budget.Refused, match='valve'):
            budget.admit(engine, model, 'extract', 1.)

        def complete(actual):
            if completion == 'settle':
                return budget.settle(token, actual)
            return budget.reconcile(token['id'], actual=actual, evidence='verified receipt')

        complete(8.)
        today = budget.day()
        yesterday = budget.day('2026-11-04')
        assert today['spent'] == 8.
        assert today['spent_by_engine'][engine] == 8.
        assert today['reserved'] == today_token['usd']
        assert today['reserved_by_engine'][engine] == today_token['usd']
        assert yesterday['reserved'] == yesterday['reserved_by_engine'][engine] == 0.
        assert yesterday['spent'] == 0.
        if engine == 'openrouter':
            assert today['openrouter_windows'] == 1
            assert today['openrouter_extract_usd'] == 8.
            assert yesterday['openrouter_windows'] == 0
        assert state.get('llm:reservation:' + token['id']) is None
        receipt = state.get('llm:reconciled:' + token['id'])
        balance = budget.balance()
        credit = state.get('credit:' + engine)
        assert complete(1.) is False
        assert budget.day() == today and budget.day('2026-11-04') == yesterday
        assert budget.balance() == balance and state.get('credit:' + engine) == credit
        assert state.get('llm:reconciled:' + token['id']) == receipt
        with pytest.raises(budget.Refused, match='valve'):
            budget.admit(engine, model, 'extract', 2.)
        assert budget.admit(engine, model, 'extract', 1.5)


def test_legacy_unindexed_hold_never_expires(funds, monkeypatch):
    budget.set_balance(10.)
    state.put('llm:day:2026-10-01', {'spent': 0., 'reserved': 9.})
    with pytest.raises(budget.Refused, match='balance'):
        budget.admit('openrouter', SOL, 'extract', 9.)


@pytest.mark.parametrize('model', [None, '', '   '])
def test_missing_model_is_refused(funds, model):
    with pytest.raises(budget.Refused, match='model_required'):
        budget.admit('openrouter', model, 'extract', 1.)
    with pytest.raises(budget.Refused, match='model_required'):
        budget.reserve(1.)


def test_unreadable_reservation_state_refuses(funds):
    state.put('llm:reservation:bad', {'id': 'bad', 'engine': 'openrouter'})
    with pytest.raises(budget.Refused):
        budget.admit('openrouter', SOL, 'extract', 1.)


def test_token_not_forgeable_or_reusable_or_transferable(funds, monkeypatch):
    token = budget.admit('openrouter', SOL, 'extract', 1.)
    with pytest.raises(budget.Refused, match='admission_required'):
        budget.before_send(dict(token), engine='openrouter', model=SOL)
    with pytest.raises(budget.Refused, match='mismatch'):
        budget.before_send(token, engine='anthropic_api', model=SOL)
    budget.before_send(token, engine='openrouter', model=SOL)
    with pytest.raises(budget.Refused, match='used'):
        budget.before_send(token, engine='openrouter', model=SOL)
    with pytest.raises(budget.Refused, match='already_sent'):
        budget.release(token)
    budget.settle(token, None)


def install_hold(which, monkeypatch, *, model=SOL, role='extract', job=None):
    if which == 'llm_off': route.set_off('openrouter', 'test', None)
    elif which == 'credit_off': state.put('credit:off:openrouter', {'reason':'test'})
    elif which == 'pace_off': monkeypatch.setitem(settings._OVERRIDE.setdefault('engines', {}).setdefault('openrouter', {}).setdefault('pace', {}), 'mode', 'off')
    elif which == 'model_hold': route.set_off(model, 'test', None)
    elif which == 'gate_pass_drop':
        with settings.override(**{'switch.gate_window':1, 'switch.baselines':{model:1.}}):
            route.apply('gate_pass_drop', key=model, passed=0, total=1)
    elif which == 'low_yield':
        with settings.override(**{'switch.yield_window':1}):
            route.apply('low_yield', key=model, empty=True)
    elif which == 'claude_job_gate': monkeypatch.setattr(route, 'claude_job_gate', lambda **kw: 'test_hold')
    elif which == 'job_hold': state.put('job:off:' + job, {'reason':'test'})
    else: raise AssertionError(which)


CONTROLS = ['llm_off','credit_off','pace_off','gate_pass_drop','low_yield','model_hold','claude_job_gate']


@pytest.mark.parametrize('entry', ['extract','support','cross'])
@pytest.mark.parametrize('control', CONTROLS)
def test_control_during_preflight_blocks_each_extract_entry(funds, ent, monkeypatch, entry, control):
    sid = H.ingest_doc()
    class Preflight(H.Fake):
        def preflight(self):
            install_hold(control, monkeypatch)
            return super().preflight()
    backend = Preflight('openrouter', True, H.extract_all(ent), cost=.01)
    if entry == 'extract':
        runner.run_agent('public', backends={'openrouter':backend}, do_support=False)
    else:
        monkeypatch.setattr(guard,'inspect_snapshot',lambda sid,text,con=None:dict(text=text,origin='external',sensitivity=0,display=None))
        with settings.override(**{'openrouter.support_calibrated':True, 'openrouter.support_model':SOL}):
            support.judge({'id':'c','snapshot':sid,'context':'context','quote':'quote','statement':'statement'},
                          {'openrouter':backend}, route.Router({'openrouter':backend}), purpose=entry, extractor='haiku')
    assert not backend.calls and budget.day()['reserved'] == 0 and budget.day()['spent'] == 0


@pytest.mark.parametrize('control', CONTROLS)
def test_control_after_admission_blocks_actual_http(funds, monkeypatch, control):
    token = budget.admit('openrouter', SOL, 'extract', 1.)
    install_hold(control, monkeypatch)
    monkeypatch.setattr(llmhttp._OPENER, 'open', lambda *a, **kw: pytest.fail('network reached'))
    with pytest.raises(budget.Refused):
        llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions', body={'model':SOL},
                             admission=token, engine='openrouter', model=SOL)
    budget.release(token)


@pytest.mark.parametrize('boundary', ['backend','http','cli','api_canary'])
def test_every_paid_boundary_requires_admission(funds, monkeypatch, boundary):
    monkeypatch.setattr(llmhttp._OPENER, 'open', lambda *a, **kw: pytest.fail('network reached'))
    monkeypatch.setattr(paid.subprocess, 'Popen', lambda *a, **kw: pytest.fail('CLI reached'))
    with pytest.raises(budget.Refused):
        if boundary == 'backend':
            monkeypatch.setattr(guard, 'verify', lambda *a:None)
            OpenRouter().extract(Job(Window('w','s','t',[]), model=SOL), None)
        elif boundary in ('http','api_canary'):
            llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions', body={'model':SOL}, engine='openrouter', model=SOL)
        else:
            paid.popen(None, ['claude','-p','--model',SOL,'--max-budget-usd','1'], engine='openrouter', model=SOL, job='kb-fulfill')


def test_preflight_mutation_after_admit_still_cannot_reach_transport(funds, monkeypatch):
    token = budget.admit('openrouter', SOL, 'extract', 1.)
    def blocked(*a, **kw): pytest.fail('transport reached')
    monkeypatch.setattr(llmhttp._OPENER, 'open', blocked)
    # Change a control inside HTTP request construction, after the outer backend check.
    real = llmhttp.urllib.request.Request
    def construct(*a, **kw):
        req = real(*a, **kw)
        route.set_off(SOL, 'low_yield', None)
        return req
    monkeypatch.setattr(llmhttp.urllib.request, 'Request', construct)
    with pytest.raises(budget.Refused):
        llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions', body={'model':SOL}, admission=token, engine='openrouter', model=SOL)


# Discover every production backend and low-level send. A new module/entry point must
# be added to the table and exercised; unexplained raw transports are forbidden.
BACKENDS = {'openrouter.OpenRouter':'paid', 'claude.Claude':'blocked', 'codex.Codex':'blocked', 'sllm.Sllm':'local'}
ENTRY_POINTS = [
    ('extract/runner.py','_call','admit','extract'),
    ('extract/support.py','judge','admit','extract'),
    ('agentrun/runner.py','_run','admit','popen'),
    ('extract/backends/openrouter.py','extract','before_send','_req'),
    ('extract/llmhttp.py','request_json','before_send','open'),
    ('extract/paid.py','popen','before_send','Popen'),
    ('extract/paid.py','extract','before_send','extract'),
]


@pytest.mark.parametrize('path,name,admit,send', ENTRY_POINTS)
def test_entry_point_table_requires_admission(path, name, admit, send):
    root=Path(__file__).resolve().parents[2]/'src/kb'
    tree=ast.parse((root/path).read_text())
    fn=next(n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name)
    calls=[n.func.attr if isinstance(n.func,ast.Attribute) else n.func.id if isinstance(n.func,ast.Name) else ''
           for n in ast.walk(fn) if isinstance(n,ast.Call)]
    assert admit in calls and send in calls


def test_new_backends_or_raw_transports_cannot_silently_bypass():
    root=Path(__file__).resolve().parents[2]/'src/kb'
    found={}
    for p in (root/'extract/backends').glob('*.py'):
        tree=ast.parse(p.read_text())
        for cls in (n for n in tree.body if isinstance(n,ast.ClassDef)):
            if any(isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='external' for t in n.targets) for n in cls.body):
                found[p.stem+'.'+cls.name]=True
        for node in ast.walk(tree):
            if isinstance(node,(ast.Import,ast.ImportFrom)):
                names=[n.name for n in node.names] if isinstance(node,ast.Import) else [node.module or '']
                assert not any(n.split('.')[0] in {'requests','httpx','aiohttp','urllib'} for n in names), p
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='subprocess':
                # Only metadata/resource helpers remain outside the paid CLI helper.
                owner=next((f.name for f in ast.walk(tree) if isinstance(f,ast.FunctionDef) and node in list(ast.walk(f))), '')
                assert (p.stem,owner,node.func.attr) in {('claude','_auth_ok','run'),('codex','rate_limits','Popen'),('sllm','free_vram_mib','run'),('sllm','start','Popen')}, (p,owner)
    assert set(found)==set(BACKENDS)
    for qualified in found:
        if BACKENDS[qualified]=='paid':
            module=qualified.split('.')[0]
            assert any(row[0]==f'extract/backends/{module}.py' and row[1]=='extract' for row in ENTRY_POINTS)
    tree=ast.parse((root/'extract/budget.py').read_text())
    issuers=[f.name for f in ast.walk(tree) if isinstance(f,ast.FunctionDef)
             and any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_Admission' for n in ast.walk(f))]
    assert issuers==['admit']


@pytest.mark.parametrize('entry', ['extract','support','cross'])
def test_each_extract_entry_issues_exact_bound_admission(funds, ent, monkeypatch, entry):
    sid=H.ingest_doc()
    calls=[]
    real=budget.admit
    def admit(*a,**kw):
        calls.append((a,kw))
        return real(*a,**kw)
    monkeypatch.setattr(budget,'admit',admit)
    backend=H.Fake('openrouter',True,H.extract_all(ent),cost=.01)
    if entry=='extract':
        runner.run_agent('public',backends={'openrouter':backend},do_support=False)
    else:
        monkeypatch.setattr(guard,'inspect_snapshot',lambda sid,text,con=None:dict(text=text,origin='external',sensitivity=0,display=None))
        with settings.override(**{'openrouter.support_calibrated':True,'openrouter.support_model':SOL}):
            support.judge({'id':'c','snapshot':sid,'context':'context','quote':'quote','statement':'statement'},
                          {'openrouter':backend},route.Router({'openrouter':backend}),purpose=entry,extractor='haiku')
    assert len(calls)==1 and len(backend.calls)==1
    args,kw=calls[0]
    assert args[:3]==('openrouter',SOL,entry) and args[3]>0
    assert kw['job']==backend.calls[0].window.window_id


def test_api_canary_uses_same_single_use_admission(funds, monkeypatch):
    class Response(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self,*a): self.close()
    calls=[]
    def opened(*a,**kw):
        calls.append(True)
        return Response(b'{}')
    monkeypatch.setattr(llmhttp._OPENER,'open',opened)
    token=budget.admit('openrouter',SOL,'canary',.1,job='api-canary')
    llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions',body={'model':SOL},admission=token,engine='openrouter',model=SOL)
    assert calls==[True]
    with pytest.raises(budget.Refused,match='used'):
        llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions',body={'model':SOL},admission=token,engine='openrouter',model=SOL)
    budget.settle(token,.01)


def test_subscription_canaries_and_adapters_are_physically_blocked(funds, monkeypatch):
    from kb.extract.backends.claude import Claude,run_claude
    from kb.extract.backends.codex import Codex
    import subprocess
    monkeypatch.setattr(subprocess,'run',lambda *a,**kw:pytest.fail('subscription process'))
    monkeypatch.setattr(subprocess,'Popen',lambda *a,**kw:pytest.fail('subscription process'))
    assert not Claude().canary().ok
    assert run_claude('haiku','system','user',{},1.,'w').error=='subscription_automatic_forbidden'
    job=Job(Window('w','s','t',[]),model='m',user='user')
    permit=guard.authorize([{'text':'user','origin':'external','sensitivity':0,'display':None}],'codex','user')
    assert Codex().extract(job,permit).error=='subscription_automatic_forbidden'


def test_transport_registry_discovers_new_raw_sends():
    root=Path(__file__).resolve().parents[2]/'src/kb'
    files=[*(root/'extract').rglob('*.py'),*(root/'agentrun').glob('*.py'),root/'commands/jobs.py',root/'metrics/retro.py']
    allowed={
      ('extract/paid.py','popen','Popen'),('agentrun/auth.py','preflight','run'),
      ('commands/jobs.py','run_due','run'),('metrics/retro.py','run','run'),
      ('extract/backends/codex.py','rate_limits','Popen'),('extract/backends/claude.py','_auth_ok','run'),
      ('extract/backends/sllm.py','free_vram_mib','run'),('extract/backends/sllm.py','start','Popen')}
    found=[]
    import sys
    allowed_imports=set(sys.stdlib_module_names)|{'kb','jsonschema','yaml'}
    for p in files:
        tree=ast.parse(p.read_text())
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):
                for n in node.names:
                    assert n.name.split('.')[0] in allowed_imports,(p,n.name)
                    assert not(n.name=='subprocess' and n.asname),p
                    if n.name.split('.')[0] in {'urllib','httpx','requests','aiohttp','socket','http'}:
                        assert p==root/'extract/llmhttp.py',p
            if isinstance(node,ast.ImportFrom):
                if node.module:
                    assert node.module.split('.')[0] in allowed_imports,(p,node.module)
                assert node.module not in {'subprocess','requests','httpx','socket','http.client'},p
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='subprocess':
                owner=next((f.name for f in ast.walk(tree) if isinstance(f,ast.FunctionDef) and node in list(ast.walk(f))), '')
                key=(str(p.relative_to(root)),owner,node.func.attr)
                found.append(key)
                if key in {('agentrun/auth.py','preflight','run'),('extract/backends/claude.py','_auth_ok','run')}:
                    argv=node.args[0]
                    assert isinstance(argv,ast.List)
                    assert [e.value for e in argv.elts[-2:] if isinstance(e,ast.Constant)]==['auth','status']
                    assert not any(isinstance(e,ast.Constant) and e.value in {'-p','--print','exec'} for e in argv.elts)
                if key==('extract/backends/codex.py','rate_limits','Popen'):
                    assert isinstance(node.args[0],ast.List) and len(node.args[0].elts)==2
                    assert isinstance(node.args[0].elts[1],ast.Constant) and node.args[0].elts[1].value=='app-server'
    from collections import Counter
    assert Counter(found)==Counter({key:1 for key in allowed})


def test_engine_bound_token_cannot_bill_another_host(funds, monkeypatch):
    token=budget.admit('openrouter',SOL,'extract',1.)
    monkeypatch.setattr(llmhttp._OPENER,'open',lambda *a,**kw:pytest.fail('wrong engine host reached'))
    with pytest.raises(budget.Refused,match='engine_host_mismatch'):
        llmhttp.request_json('https://api.openai.com/v1/responses',body={'model':SOL},admission=token,engine='openrouter',model=SOL)
    budget.release(token)


@pytest.mark.parametrize('change', ['balance','day','pace','credit'])
def test_money_rechecked_at_http_boundary(funds, monkeypatch, change):
    token=budget.admit('openrouter',SOL,'extract',1.)
    if change=='balance': budget.set_balance(.5)
    elif change=='day':
        d=budget.day();d['spent']=59.5;state.put(budget.day_key(),d)
    elif change=='pace':
        monkeypatch.setitem(settings._OVERRIDE.setdefault('engines',{}).setdefault('openrouter',{}).setdefault('pace',{}),'cap_day_usd',.5)
    else:
        state.put('credit:openrouter',dict(balance=100.,budget_usd=100.,cycle_spent=0.,spent_today=0.,reserved=1.,cap_today=.5))
    monkeypatch.setattr(llmhttp._OPENER,'open',lambda *a,**kw:pytest.fail('over-budget request reached'))
    with pytest.raises(budget.Refused):
        llmhttp.request_json('https://openrouter.ai/api/v1/chat/completions',body={'model':SOL},admission=token,engine='openrouter',model=SOL)
    budget.release(token)
