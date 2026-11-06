"""ADR-0004 7.2/7.4: automatic engine allow-list, authentication and arm selection.

Pace is configuration, not inferred from a key's expiry or subscription usage.
O1/A1 supply additional executors; an absent executor is never a fallback.
"""
from __future__ import annotations

import math
import os
import random
import re
import stat
from dataclasses import dataclass

from kb.core import paths
from kb.extract import llmhttp, settings, state

API_ENGINES = frozenset({'openrouter', 'openai_api', 'anthropic_api'})
AUTO_ENGINES = API_ENGINES | {'local'}
LOCAL_TASKS = frozenset({'classify', 'map_fields', 'dedup', 'alias', 'sensitive'})
HOSTS = {'openrouter': 'https://openrouter.ai/api', 'openai_api': 'https://api.openai.com/v1',
         'anthropic_api': 'https://api.anthropic.com'}
# User-confirmed 2026-11-04; informational, never changes pace flags.
CREDIT_INFO = {'openrouter': {'expires': '2026-11-30'},
               'openai_api': {'monthly_usd': 200, 'reset_day': 28},
               'anthropic_api': {'monthly_usd': 200, 'reset_day': 26},
               'local': {'cost_usd': 0}}
KEY_FILES = {'openrouter': 'openrouter.key', 'openai_api': 'openai.key', 'anthropic_api': 'anthropic.key'}


class AuthError(ValueError):
    """Messages are identifiers only; provider output and credentials are never included."""


def read_key(engine: str) -> str:
    if engine not in KEY_FILES:
        raise AuthError('unsupported_api_engine')
    try:
        p = paths.config_dir() / KEY_FILES[engine]
        with p.open(encoding='utf-8') as f:
            mode = os.fstat(f.fileno()).st_mode
            if not stat.S_ISREG(mode) or stat.S_IMODE(mode) != 0o600:
                raise AuthError('key_permissions')
            key = f.read().strip()
    except OSError:
        raise AuthError('key_unavailable') from None
    if not key:
        raise AuthError('key_empty')
    return key


def redact(text: str, secrets=(), *, partial=False) -> str:
    for secret in secrets:
        if not secret:
            continue
        text = text.replace(secret, '<redacted>')
        if partial:
            # Upstream errors can already contain an abbreviated key. Remove known
            # prefixes of four or more characters, plus even a one-byte torn tail.
            prefixes = [re.escape(secret[:n]) for n in range(len(secret) - 1, 3, -1)]
            if prefixes:
                text = re.sub('|'.join(prefixes), '<redacted>', text)
            for n in range(min(len(secret) - 1, 3), 0, -1):
                if text.endswith(secret[:n]):
                    text = text[:-n] + '<redacted>'
                    break
    return text


def check_host(engine: str, url: str) -> None:
    from urllib.parse import urlsplit
    llmhttp._check(url)
    u = urlsplit(url)
    expected = urlsplit(HOSTS.get(engine, '')).hostname
    if u.scheme == 'http' and u.hostname in {'127.0.0.1', '::1', 'localhost'}:
        return
    if u.hostname != expected or u.scheme != 'https':
        raise AuthError('engine_host_mismatch')


def auth_signature(engine: str, info: dict, *, phase='preflight', mechanism='env') -> bool:
    """No provider-auth response is logged. Missing signatures fail closed."""
    if mechanism == 'helper':
        if engine not in {'openrouter', 'anthropic_api'}:
            return False
        return (info.get('authMethod') == 'api_key' and info.get('apiKeySource') == 'apiKeyHelper'
                if phase == 'preflight' else info.get('apiKeySource') == 'apiKeyHelper')
    if engine == 'anthropic_api':
        return (info.get('authMethod') == 'api_key' if phase == 'preflight'
                else info.get('apiKeySource') == 'ANTHROPIC_API_KEY')
    if engine == 'openrouter':
        return (info.get('authMethod') in {'api_key', 'auth_token'} if phase == 'preflight'
                else info.get('apiKeySource') in {'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'})
    return False


@dataclass(frozen=True)
class Arm:
    task: str
    engine: str
    model: str

    @property
    def key(self):
        return f'llm:arm:{self.task}:{self.engine}:{self.model}'


def record(arm: Arm, *, cost=0.0, accepted=0, held=0, rejected=0, schema_failed=False,
           truncated=False, audited=0, distorted=0) -> None:
    rows = state.get(arm.key) or []
    rows.append(dict(cost=float(cost), accepted=accepted, held=held, rejected=rejected,
                     schema_failed=bool(schema_failed), truncated=bool(truncated), audited=audited, distorted=distorted))
    state.put(arm.key, rows[-(50 if arm.task == 'agent' else 200):])


def record_audit(arm: Arm, *, distorted: bool) -> None:
    """Attach audit quality to the arm without counting another paid extraction."""
    rows = state.get(arm.key) or []
    if not rows:
        return  # Historical claims have no E1 observation to amend.
    rows[-1]['audited'] += 1
    rows[-1]['distorted'] += int(distorted)
    state.put(arm.key, rows)


def score(arm: Arm) -> dict:
    rows = state.get(arm.key) or []
    n = len(rows)
    accepted = sum(r['accepted'] for r in rows)
    total = sum(r['accepted'] + r['held'] + r['rejected'] for r in rows)
    audits = sum(r['audited'] for r in rows)
    distorted = sum(r['distorted'] for r in rows)
    failures = sum(bool(r['schema_failed'] or r['truncated']) for r in rows)
    quality = (n > 0 and total > 0 and accepted / total >= float(settings.get(f'selector.floors.{arm.task}', .70))
               and (not audits or distorted / audits <= .05) and failures / n <= .05)
    cost = sum(r['cost'] for r in rows)
    value = (math.inf if arm.engine == 'local' else accepted / cost if cost > 0 else 0.0) if quality else 0.0
    return dict(samples=n, quality=quality, score=value)


def controls_allow(arm: Arm) -> bool:
    from kb.extract.route import is_off, model_key
    if arm.engine not in AUTO_ENGINES:
        return False
    if is_off(arm.engine) or is_off(model_key(arm.engine, arm.model)) or is_off(f"{arm.engine}:{arm.model}"):
        return False
    if state.get(f'arm:off:{arm.task}:{arm.engine}:{arm.model}') is not None or state.get(f'credit:off:{arm.engine}') is not None:
        return False
    if not settings.get(f'engines.{arm.engine}.enabled', True):
        return False
    if arm.engine == 'openrouter' and not settings.get('openrouter.enabled', True):
        return False
    return settings.get(f'engines.{arm.engine}.pace.mode') != 'off'


def available(arm: Arm, *, executable=True, authenticate=True, reserve_usd=0.) -> bool:
    if not executable or not controls_allow(arm):
        return False
    if arm.engine == 'openrouter':
        import datetime
        expires = settings.get('openrouter.key_expires_at')
        if expires and datetime.datetime.fromisoformat(str(expires)).timestamp() <= settings.now_s():
            return False
    if arm.engine == 'local':
        from kb.extract.route import is_off
        return settings.get('sllm.enabled', True) and not is_off('sllm')
    from kb.extract import budget
    try:
        budget.check(arm.engine, reserve_usd)
    except budget.Refused:
        return False
    if authenticate:
        try:
            read_key(arm.engine)
            check_host(arm.engine, HOSTS[arm.engine])
        except AuthError:
            return False
    return True


def select(task: str, arms: list[Arm], *, needs_external=True, eligible=None, rng=None) -> Arm | None:
    """Select once before executing; consumer engines cannot be injected via configuration."""
    rng = rng or random
    eligible = eligible or available
    local_only = not needs_external or task in LOCAL_TASKS
    candidates = [a for a in arms if a.task == task and a.engine in AUTO_ENGINES
                  and (not local_only or a.engine == 'local') and eligible(a)]
    if not candidates:
        return None
    stats = {a: score(a) for a in candidates}
    local = [a for a in candidates if a.engine == 'local' and stats[a]['quality']]
    if local:
        return local[0]
    minimum = 20 if task == 'agent' else 200
    under = [a for a in candidates if stats[a]['samples'] < minimum]
    if under and rng.random() < float(settings.get('selector.epsilon', .10)):
        return min(under, key=lambda a: stats[a]['samples'])
    # A measured quality failure cannot win exploitation. Unmeasured arms bootstrap
    # only when no qualified arm exists; exploration remains possible below minimum.
    good = [a for a in candidates if stats[a]['quality']]
    if not good:
        return min(under, key=lambda a: stats[a]['samples']) if under else None
    best = max(stats[a]['score'] for a in good)
    near = [a for a in good if stats[a]['score'] >= .8 * best]
    def rank(a):
        c = state.get(f'credit:{a.engine}') or {}
        planned = float(c.get('planned_spend', 0))
        lag = max(0., (planned - float(c.get('cycle_spent', 0))) / planned) if planned > 0 and a.engine in {'openai_api', 'anthropic_api'} else 0.
        return lag, stats[a]['score']
    return max(near, key=rank)
