"""후보 합집합과 순서(ADR 14.2 2~4). 점수를 섞지 않는다: RRF, 선형 결합 없음. 표준 라이브러리만 쓴다."""
from __future__ import annotations

from kb.rank import conf


def interleave(*lists: list[str]) -> list[str]:
    """Dense 순서: 종류별 순위를 번갈아 잇는다(종류 사이 점수 비교 없음). 중복은 처음 것만."""
    out, seen = [], set()
    for i in range(max((len(x) for x in lists), default=0)):
        for x in lists:
            if i < len(x) and x[i] not in seen:
                seen.add(x[i])
                out.append(x[i])
    return out


def pool(dense_fact: list[str], dense_passage: list[str], lexical: list[str], entity: list[str]) -> list[str]:
    """r=c의 순서이기도 하다: Dense 순서 뒤에 어휘 전용, 그 뒤에 엔티티 전용."""
    dense = interleave(dense_fact, dense_passage)
    seen = set(dense)
    tail = [x for x in lexical if x not in seen]
    seen.update(tail)
    return dense + tail + [x for x in entity if x not in seen]


def rerank_order(cands: list[str], logits: list[float], floor: float = conf.LOGIT_FLOOR) -> list[str]:
    """로짓 내림차순(동점은 후보 순서), floor 미만은 버린다."""
    if len(cands) != len(logits):
        raise ValueError("후보와 로짓 수 불일치")
    keep = [(-lg, i) for i, lg in enumerate(logits) if lg >= floor]
    keep.sort()
    return [cands[i] for _, i in keep]
