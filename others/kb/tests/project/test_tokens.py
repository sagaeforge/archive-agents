"""표기 공격 표본 26건의 토큰 규칙을 고정한다(ADR 14.1)."""
import json
from pathlib import Path

from kb.core.text import index_tokens, nfc, query_tokens

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "tokens"


def _variants(q: str, groups: list[set[str]]) -> list[str]:
    qn = nfc(q).lower()
    out = [qn]
    for g in groups:
        for key in sorted(g, key=len, reverse=True):
            if key in qn:
                out += [qn.replace(key, alt) for alt in sorted(g) if alt != key]
                break
    return out


def _search(corpus, alias, q):
    groups = []
    for k, alts in alias.items():
        groups.append({nfc(k).lower(), *(nfc(a).lower() for a in alts)})
    docs = {d["id"]: set(index_tokens(d["text"])) for d in corpus}
    hits = set()
    for v in _variants(q, groups):
        qt = query_tokens(v)
        if qt:
            hits |= {i for i, t in docs.items() if all(x in t for x in qt)}
    if hits:
        return hits, "and"
    qt = set(query_tokens(q))
    for v in _variants(q, groups):
        qt |= set(query_tokens(v))
    score = {i: len(qt & t) for i, t in docs.items()}
    best = max(score.values())
    return {i for i, s in score.items() if s == best and s > 0}, "or"


def test_attack_cases():
    d = json.loads((FIX / "attack.json").read_text(encoding="utf-8"))
    assert len(d["cases"]) == 26
    bad = []
    for c in d["cases"]:
        hits, how = _search(d["corpus"], d["alias"], c["query"])
        if c["expect"] not in hits:
            bad.append((c["query"], c["expect"], sorted(hits), how))
    assert not bad, bad


def test_pinned_tokens():
    assert index_tokens("8,000시간으로") == ["8000", "시간", "간으", "으로"]
    assert index_tokens("2.1.314") == ["2_1_314", "2", "1", "314"]
    assert query_tokens("search.list") == ["searchlist", "search", "list"]
    assert query_tokens("dump_json") == query_tokens("--dump-json") == ["dumpjson", "dump", "json"]
    assert query_tokens("C++") == ["cplusplus"] and query_tokens("C#") == ["csharp"] and query_tokens(".NET") == ["dotnet"]
    assert index_tokens("앱을") == ["앱을", "앱"]
    assert query_tokens("앱") == ["앱"]
    assert index_tokens("훅에서는") == ["훅에", "에서", "서는"]
    assert query_tokens("GPT-5.5") == ["gpt55", "gpt", "5"]


def test_edge_one_syllable_noun_limit():
    """3음절 이하 어절만 1음절 질의로 찾는다. 4음절 이상 어절 속 1음절 명사는 찾지 못한다(감사 R15)."""
    e = json.loads((FIX / "attack_edge.json").read_text(encoding="utf-8"))["edge_sentences"]
    found = [bool(set(query_tokens(s[0])) <= set(index_tokens(s))) for s in e]
    assert found == [True, True, True, False, False, False, False, False, False]
