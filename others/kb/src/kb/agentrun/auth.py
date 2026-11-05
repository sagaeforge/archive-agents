"""격리한 CLI 인증: apiKeyHelper의 stdout 파이프로만 키를 넘긴다.

환경, argv, 설정 JSON에는 키 값이 없다. 훅은 전부 끄고 MCP는 명시한 collector만
환경 허용 목록을 적용하는 실행기를 거친다. CLI 2.1.318의 apiKeyHelper/source
구현을 로컬에서 확인했다(2026-11-04). 공급자 호출로 확인하지 않는다.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from kb.core import paths
from kb.extract import engines

CHILD_ENV = frozenset({'HOME', 'PATH', 'LANG', 'LC_CTYPE', 'KB_HOME', 'KB_SHARE', 'KB_CONFIG_DIR',
                       'KB_JOB', 'DISABLE_AUTOUPDATER', 'CLAUDE_CONFIG_DIR'})


def descendant_env(base: dict) -> dict:
    """훅/서버/키 도우미에 공급자 인증 환경을 상속하지 않는다."""
    return {k: v for k, v in base.items() if k in CHILD_ENV}


def _command(entry: str, *args: str) -> list[str]:
    source = str(Path(__file__).resolve().parents[2])
    code = f'import sys; sys.path.insert(0, {source!r}); from kb.agentrun.auth import {entry}; {entry}(*sys.argv[1:])'
    return [sys.executable, '-I', '-c', code, *args]


def key_helper(engine: str) -> None:
    """CLI가 캡처하는 전용 stdout. 사용자 로그/오류에는 키를 쓰지 않는다."""
    try:
        key = engines.read_key(engine)
    except engines.AuthError:
        raise SystemExit('api_key_helper_unavailable') from None
    sys.stdout.write(key + '\n')


def mcp_child() -> None:
    executable = str(paths.kb_home() / 'runtime' / 'bin' / 'kb-mcp')
    os.execve(executable, [executable, '--profile', 'collector'], descendant_env(os.environ))


@contextmanager
def environment(engine: str, base: dict, *, settings_path=None, mcp=False):
    if engine not in {'openrouter', 'anthropic_api'}:
        raise engines.AuthError('executor_unavailable')
    secret = engines.read_key(engine)  # retained by the supervisor only for redaction
    root = paths.test_tmp_dir()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='kb-api-', dir=root) as home:
        env = descendant_env(base)
        env.update(HOME=home, CLAUDE_CONFIG_DIR=home, KB_CONFIG_DIR=str(paths.config_dir()),
                   CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS='0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
        if engine == 'openrouter':
            engines.check_host(engine, engines.HOSTS[engine])
            env.update(ANTHROPIC_BASE_URL=engines.HOSTS[engine],
                       ANTHROPIC_DEFAULT_HAIKU_MODEL='anthropic/claude-haiku-5.5',
                       ANTHROPIC_DEFAULT_SONNET_MODEL='anthropic/claude-sonnet-5.5')
        doc = json.loads(Path(settings_path).read_text()) if settings_path else {}
        # Never merge project hooks, env or MCP definitions into the trusted overlay.
        doc = {'permissions': doc.get('permissions', {}), 'disableAllHooks': True,
               'enableAllProjectMcpServers': False, 'enabledMcpjsonServers': [],
               'apiKeyHelper': shlex.join(_command('key_helper', engine))}
        settings_file = Path(home) / 'api-settings.json'
        settings_file.write_text(json.dumps(doc))
        env['KB_API_SETTINGS'] = str(settings_file)
        if mcp:
            command = _command('mcp_child')
            cfg = {'mcpServers': {'kb-collect': {'command': command[0], 'args': command[1:],
                                               'env': {k: '' for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
                                                                       'OPENAI_API_KEY', 'CODEX_API_KEY')}}}}
            config_file = Path(home) / 'api-mcp.json'
            config_file.write_text(json.dumps(cfg))
            env['KB_API_MCP_CONFIG'] = str(config_file)
        yield env, secret


def preflight(binary: str, engine: str, env: dict) -> bool:
    try:
        p = subprocess.run([binary, '--setting-sources', '', '--settings', env['KB_API_SETTINGS'], '--strict-mcp-config', 'auth', 'status'],
                           env=env, capture_output=True, text=True, timeout=30)
        info = json.loads(p.stdout)
        return p.returncode == 0 and engines.auth_signature(engine, info, mechanism='helper')
    except Exception:
        return False


def mismatch(engine: str) -> None:
    from kb.extract import route, state
    route.set_off(engine, 'auth_signature', None)
    state.incident('other', f'API authentication signature mismatch: {engine}')
