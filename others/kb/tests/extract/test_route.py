"""E1 automatic plans have no subscription or Codex fallback."""
from kb.extract import budget, route, runner, settings
from . import helpers as H


def names(p):
    return [(c.backend, c.model) for c in p.cands]


def test_public_only_api_candidates(envk):
    budget.set_balance(100.)
    p = route.Router().plan('public')
    assert {c.backend for c in p.cands} == {'openrouter'}
    with settings.override(**{'codex.enabled': True}):
        assert all(c.backend not in {'codex', 'claude', 'claude_sub'} for c in route.Router().plan('public').cands)


def test_exhausted_keeps_work_queued(envk):
    budget.set_balance(.01)
    assert not route.Router().plan('public').cands


def test_sensitive_local_only(env):
    for purpose in ('extract', 'classify'):
        assert names(route.Router().plan('sensitive', purpose)) == [('sllm', settings.get('sllm.model'))]
    assert route.Router().plan('sensitive', 'support').stop == 'sensitive_no_judge'


def test_excluded_zero_candidates(env):
    assert route.Router().plan('excluded').stop == 'excluded'


def test_support_requires_calibration(envk):
    budget.set_balance(100.)
    assert not route.Router().plan('public', 'support').cands
    with settings.override(**{'openrouter.support_calibrated': True}):
        assert names(route.Router().plan('public', 'support')) == [('openrouter', route.OR_SONNET)]


def test_cross_other_vendor(envk):
    budget.set_balance(100.)
    assert names(route.Router().plan('public', 'cross', extractor=route.SOL)) == [('openrouter', route.OR_SONNET)]


def test_unavailable_backends_zero_calls(ent):
    H.ingest_doc()
    fake = H.Fake('claude', True, H.extract_all(ent))
    out = runner.run_agent('public', backends={'claude': fake}, do_support=False)
    assert not fake.calls and not out['windows'] and runner.queue_left() == 4
