"""문단 단위 캐시와 큐 소속(ADR 10.5, ADR-0003 2장). 큐 소속은 (para_sha, prompt_version, extract_schema)로 판정하고
백엔드와 모델을 보지 않는다. 그래서 경로가 바뀌어도 이미 뽑은 문단을 다시 부르지 않는다.
원응답 재사용 키는 (window_sha, extractor_id, prompt_version, extract_schema, model)이다.
done_carry에 적은 옛 판본의 완료 표시는 이미 뽑은 문단으로 인정한다. 판본을 올려도 끝난 문단을 저절로 다시 부르지 않는다.
옛 주장을 철회하는 재추출은 명시 명령 --reextract뿐이다(ADR 7.6)."""
from __future__ import annotations

import json

from kb.core import opsdb
from kb.extract import settings


def _pfx() -> str:
    return f"ex:done:{settings.get('prompt_version')}:{settings.get('extract_schema')}:"


def _carried() -> list:
    """완료 표시를 인정하는 옛 판본의 키 머리. 값은 "prompt_version:extract_schema" 목록이다(extract.yaml done_carry)."""
    return [f"ex:done:{v}:" for v in settings.get("done_carry") or []]


def is_carried(ver: str) -> bool:
    """ver: tick_stage가 남긴 "prompt_version|extract_schema"."""
    return f"ex:done:{ver.replace('|', ':')}:" in _carried()


def done_keys(para_shas: list) -> set:
    """이미 추출한 문단 sha 집합. 현재 판본과 done_carry의 판본을 함께 본다."""
    if not para_shas:
        return set()
    c = opsdb.connect()
    try:
        out = set()
        for pfx in dict.fromkeys([_pfx(), *_carried()]):
            for i in range(0, len(para_shas), 500):
                chunk = para_shas[i:i + 500]
                q = ",".join("?" * len(chunk))
                for (k,) in c.execute(f"SELECT k FROM tick_state WHERE k IN ({q})", [pfx + s for s in chunk]):
                    out.add(k[len(pfx):])
        return out
    finally:
        c.close()


def mark_done(para_shas: list, window_sha: str) -> None:
    c = opsdb.connect()
    try:
        pfx = _pfx()
        c.executemany("INSERT INTO tick_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      [(pfx + s, window_sha) for s in para_shas])
    finally:
        c.close()


def clear_done(para_shas: list) -> None:
    """--reextract가 쓴다. 같은 문단을 새 extractor로 다시 뽑게 한다. 인정 중인 옛 판본의 표시도 지운다. 남기면 재추출이 건너뛴다."""
    c = opsdb.connect()
    try:
        for pfx in dict.fromkeys([_pfx(), *_carried()]):
            c.executemany("DELETE FROM tick_state WHERE k=?", [(pfx + s,) for s in para_shas])
    finally:
        c.close()


def raw_key(window_sha: str, extractor_id: str, model: str) -> str:
    return f"ex:raw:{window_sha}:{extractor_id}:{settings.get('prompt_version')}:{settings.get('extract_schema')}:{model}"


def raw_entry(window_sha: str, extractor_id: str, model: str) -> dict | None:
    """{output_sha, run_sha}. run_sha는 extract.run 페이로드의 CAS다. 커밋 전 크래시 뒤에도 같은 페이로드로 다시 쓴다."""
    from kb.extract import state
    return state.get(raw_key(window_sha, extractor_id, model))


def raw_get(window_sha: str, extractor_id: str, model: str) -> str | None:
    v = raw_entry(window_sha, extractor_id, model)
    return v.get("output_sha") if v else None


def raw_put(window_sha: str, extractor_id: str, model: str, output_sha: str, run_sha: str | None = None) -> None:
    from kb.extract import state
    state.put(raw_key(window_sha, extractor_id, model), {"output_sha": output_sha, "run_sha": run_sha})


def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False, sort_keys=True)
