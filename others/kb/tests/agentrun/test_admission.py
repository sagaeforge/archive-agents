"""The same admission invariant governs workflows and scheduled job delegation."""
import json
import os
from pathlib import Path

import pytest

from kb.agentrun import auth, runner
from kb.commands import jobs
from kb.extract import budget, route, settings, state
from arhelp import approve
from test_job_gate import fund, key, fake_cli, paid


@pytest.fixture
def funded(home, monkeypatch):
    fund(home)
    key(home, 'openrouter')
    approve(home, 11)
    monkeypatch.setenv('KB_CLAUDE_BIN', str(fake_cli(home)))
    with settings.override(**{'selector.epsilon':0, 'openrouter.daily_valve_usd':60}):
        yield home


@pytest.mark.parametrize('entry', ['workflow','jobs','retro'])
def test_paid_entry_point_calls_the_single_admission_function(funded, monkeypatch, entry):
    if entry=='workflow':
        calls=[]
        real=budget.admit
        def admit(*args,**kw):
            calls.append((args,kw))
            return real(*args,**kw)
        monkeypatch.setattr(budget,'admit',admit)
        assert runner.main(['kb-fulfill','--engine','openrouter'])==0
        assert len(calls)==1 and calls[0][0][:3]==('openrouter','anthropic/claude-haiku-5.5','agent')
    elif entry=='retro':
        from kb.metrics import retro
        monkeypatch.setenv('KB_AGENT_RUN',str(Path(__file__).resolve().parents[2]/'ops/bin/kb-agent-run'))
        assert retro.run({'week':'2026-W45'},engine='openrouter')['called']
    else:
        monkeypatch.setattr(jobs,'load_agent_jobs',lambda:[{'id':'agents.fulfill','cmd':'kb-agent-run kb-fulfill'}])
        monkeypatch.setenv('KB_AGENT_RUN',str(Path(__file__).resolve().parents[2]/'ops/bin/kb-agent-run'))
        assert not jobs.run_due()['failed']
    observations=paid(funded)
    assert len(observations)==1
    records=observations[0]['admissions']
    assert len(records)==1
    assert records[0]['model']=='anthropic/claude-haiku-5.5' and records[0]['purpose']=='agent'
    assert records[0]['job']==('kb-retro' if entry=='retro' else 'kb-fulfill') and records[0]['stage']=='sent'
    assert budget.day()['spent']==.25 and budget.day()['reserved']==0


@pytest.mark.parametrize('control',['llm_off','credit_off','pace_off','gate_pass_drop','low_yield','model_hold','claude_job_gate','job_hold'])
def test_control_during_workflow_preflight_blocks_admission(funded, monkeypatch, control):
    model='anthropic/claude-haiku-5.5'
    def preflight(*args):
        if control=='llm_off': route.set_off('openrouter','test',None)
        elif control=='credit_off': state.put('credit:off:openrouter',{'reason':'test'})
        elif control=='pace_off': monkeypatch.setitem(settings._OVERRIDE.setdefault('engines',{}).setdefault('openrouter',{}).setdefault('pace',{}),'mode','off')
        elif control=='gate_pass_drop':
            with settings.override(**{'switch.gate_window':1,'switch.baselines':{model:1.}}):
                route.apply('gate_pass_drop',key=model,passed=0,total=1)
        elif control=='low_yield':
            with settings.override(**{'switch.yield_window':1}):
                route.apply('low_yield',key=model,empty=True)
        elif control=='model_hold': route.set_off(model,'test',None)
        elif control=='job_hold': state.put('job:off:kb-fulfill',{'reason':'test'})
        else: monkeypatch.setattr(route,'claude_job_gate',lambda **kw:'hold')
        return True
    monkeypatch.setattr(auth,'preflight',preflight)
    assert runner.main(['kb-fulfill','--engine','openrouter'])==3
    assert not paid(funded) and budget.day()['reserved']==0 and budget.day()['spent']==0


def test_workflow_hold_after_admission_still_blocks_cli(funded, monkeypatch):
    real=budget.admit
    def admit(*args,**kw):
        token=real(*args,**kw)
        route.set_off('anthropic/claude-haiku-5.5','low_yield',None)
        return token
    monkeypatch.setattr(budget,'admit',admit)
    assert runner.main(['kb-fulfill','--engine','openrouter'])==3
    assert not paid(funded) and budget.day()['reserved']==0
