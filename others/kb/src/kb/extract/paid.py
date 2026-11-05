"""유료 전송 경계. 입장 토큰 없이 백엔드/HTTP/CLI를 실행하지 않는다."""
from __future__ import annotations

import subprocess

from kb.extract import budget


def extract(admission, backend, job, permit):
    budget.before_send(admission, engine=backend.name, model=job.model, role=job.purpose, job=job.window.window_id, consume=False)
    job.admission = admission
    return backend.extract(job, permit)


def popen(admission, argv, *, engine, model, job, role='agent', **kwargs):
    budget.before_send(admission, engine=engine, model=model, role=role, job=job, consume=False)
    if '--model' not in argv or argv[argv.index('--model') + 1] != model:
        raise budget.Refused('admission_mismatch')
    if '--max-budget-usd' not in argv or float(argv[argv.index('--max-budget-usd') + 1]) > admission['usd']:
        raise budget.Refused('admission_mismatch')
    budget.before_send(admission, engine=engine, model=model, role=role, job=job)
    try:
        return subprocess.Popen(argv, **kwargs)
    except OSError:
        budget.settle(admission, 0.)  # Popen proves no paid process was created.
        raise
