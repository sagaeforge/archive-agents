"""OpenRouter 어댑터(ADR-0003 6장). provider.order 고정, require_parameters. 키는 파일에서 이 프로세스 안으로만 읽고
출력하거나 기록하지 않는다."""
from __future__ import annotations

import json
import time

from kb.core import paths
from kb.extract import budget, guard, llmhttp, schema, settings, state
from kb.extract.types import Job, Preflight, Result

NAME = "openrouter"


def read_key() -> str | None:
    p = paths.config_dir() / str(settings.get("openrouter.key_file", "openrouter.key"))
    try:
        k = p.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return k or None


def _req(path: str, key: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    url = str(settings.get("openrouter.base_url")).rstrip("/") + path
    h = {"Authorization": "Bearer " + key, "User-Agent": "sagae-kb", "X-Title": "sagae-kb"}
    return llmhttp.request_json(url, body=body, headers=h, timeout=timeout)


def fetch_credits(key: str) -> float | None:
    """총 충전 - 총 사용. 문서는 관리 키 전용이라 적었으므로 실패해도 멈추지 않는다."""
    try:
        d = (_req("/credits", key, timeout=20.0).get("data") or {})
        return float(d["total_credits"]) - float(d["total_usage"])
    except Exception:  # noqa: BLE001
        return None


class OpenRouter:
    name = NAME
    external = True

    def preflight(self) -> Preflight:
        import datetime as dt
        if not settings.get("openrouter.enabled", True):
            return Preflight(False, "disabled")
        key = read_key()
        if not key:
            return Preflight(False, "no_key")
        exp = settings.get("openrouter.key_expires_at")
        if exp and dt.datetime.fromisoformat(str(exp)).timestamp() < settings.now_s():
            return Preflight(False, "key_expired")
        warn = ""
        cr = fetch_credits(key)
        if budget.balance() is None:
            if cr is None:
                return Preflight(False, "balance_unknown")
            budget.set_balance(cr, "credits")
        elif cr is None:
            warn = "credits_check_failed"
        else:
            state.metric("llm.credits_drift", abs(cr - (budget.balance() or 0.0)))
        if budget.exhausted():
            return Preflight(False, "balance_exhausted", warn)
        return Preflight(True, "", warn, {"balance": budget.balance()})

    def request_body(self, job: Job) -> dict:
        model = job.model
        profile = (settings.get("openrouter.schema_profiles") or {}).get(model, "full")
        sch = job.schema if job.purpose != "extract" else schema.send_schema(
            [c["id"] for c in job.window.candidates], profile)
        body = {"model": model, "messages": [{"role": "system", "content": job.system}, {"role": "user", "content": job.user}],
                "max_tokens": int(settings.get("openrouter.max_tokens", 4000)),
                "response_format": {"type": "json_schema", "json_schema": {"name": "extract", "strict": True, "schema": sch}},
                "provider": {"require_parameters": True}}
        order = (settings.get("openrouter.providers") or {}).get(model)
        if order:
            body["provider"].update(order=list(order), allow_fallbacks=False)
        return body

    def reservation_usd(self, job: Job) -> float:
        """이 요청이 쓸 수 있는 최대 비용. 입력 토큰은 요청 본문의 UTF-8 바이트 수로 본다(토큰은 1바이트 이상이므로 상한이다).
        출력은 max_tokens다. 입력이 상한을 넘으면 TooLarge."""
        body = self.request_body(job)
        tin = len(json.dumps(body, ensure_ascii=False).encode("utf-8")) + 64
        if tin > int(settings.get("openrouter.max_input_tokens", 32000)):
            raise budget.TooLarge(f"input<= {tin} tokens")
        return budget.price_bound(job.model, tin, int(body["max_tokens"]))

    def extract(self, job: Job, permit) -> Result:
        guard.verify(permit, NAME, job.user)
        key = read_key()
        r = Result(job.window.window_id, NAME, job.model)
        if not key:
            r.error, r.cost_usd = "no_key", 0.0               # 요청이 나가지 않았다
            return r
        t0 = time.time()
        try:
            d = _req("/chat/completions", key, self.request_body(job), float(settings.get("openrouter.timeout_s", 300)))
            if d.get("error"):
                r.error = "body error: " + json.dumps(d["error"], ensure_ascii=False)[:300]
            ch = (d.get("choices") or [{}])[0]
            if ch.get("error"):
                r.error = "choice error: " + json.dumps(ch["error"], ensure_ascii=False)[:300]
            r.raw = (ch.get("message") or {}).get("content")
            r.finish_reason = ch.get("finish_reason")
            u = d.get("usage") or {}
            pd, cd = u.get("prompt_tokens_details") or {}, u.get("completion_tokens_details") or {}
            r.usage = {"input_tokens": u.get("prompt_tokens"), "output_tokens": u.get("completion_tokens"),
                       "cached_input_tokens": pd.get("cached_tokens"), "reasoning_tokens": cd.get("reasoning_tokens")}
            r.cost_usd = u.get("cost")
            r.provider, r.served_model = d.get("provider"), d.get("model")
        except llmhttp.HTTPError as e:
            r.error = f"HTTP {e.code}: {e.read()[:200].decode('utf8', 'replace')}"
            if e.code in (401, 402):                       # 인증, 잔액 거절은 일을 하기 전에 끝난다. 나머지 실패는 비용을 모른다(None)
                r.cost_usd = 0.0
        except Exception as e:  # noqa: BLE001
            r.error = f"{type(e).__name__}: {str(e)[:200]}"
        r.elapsed_s = round(time.time() - t0, 3)
        return r
