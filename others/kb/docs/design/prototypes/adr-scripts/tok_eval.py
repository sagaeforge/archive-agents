"""어휘 경로 수정안 평가. 데이터는 비신뢰 JSON이고 코드로 실행하지 않는다.
모드:
  base   문자 bigram + 라틴·숫자 토큰(현 설계 기준)
  fix    base + 숫자 구분 기호 제거 + 식별자 결합형 + 한글 런 첫 음절 단음절 토큰
질의: AND(모든 토큰) 결과 뒤에 OR 결과를 잇는다. 별칭 사전은 질의 앞단에서 확장한다.
"""
import json, math, re, sqlite3, sys, time, unicodedata

HANGUL = "가-힣"
RUN = re.compile(rf"[{HANGUL}]+|[0-9][0-9,]*(?:\.[0-9]+)*|[a-z0-9][a-z0-9._+#-]*|\.[a-z][a-z0-9]*", re.I)
SPECIAL = {"c++": "cplusplus", "c#": "csharp", ".net": "dotnet"}


def norm(s):
    return unicodedata.normalize("NFC", s).lower()


def toks(text, mode, query=False):
    out = []
    for m in RUN.finditer(norm(text)):
        w = m.group()
        if re.match(rf"[{HANGUL}]", w):
            if len(w) == 1:
                out.append(w)
            else:
                out.extend(w[i : i + 2] for i in range(len(w) - 1))
                if mode == "fix" and not query and len(w) <= 3:
                    out.append(w[0])  # 3음절 이하 어절의 첫 음절. "앱을" -> 앱
            continue
        if mode == "base":
            out.extend(p for p in re.split(r"[^a-z0-9]+", w) if p)
            continue
        if w in SPECIAL:
            out.append(SPECIAL[w])
            continue
        if re.fullmatch(r"[0-9,]+(\.[0-9]+)*", w):
            out.append(w.replace(",", "").replace(".", "_"))  # 8,000 -> 8000, 2.1.314 -> 2_1_314
            parts = [p for p in re.split(r"[.,]", w) if p]
            if not query and len(parts) > 1 and "," not in w:
                out.extend(parts)
            continue
        parts = [p for p in re.split(r"[^a-z0-9]+", w) if p]
        if len(parts) > 1:
            out.append("".join(parts))  # search.list -> searchlist
            if not query:
                out.extend(parts)
            else:
                out.extend(p for p in parts if p not in out)
        elif parts:
            out.append(parts[0])
    return out


def ddl(c):
    c.execute("create virtual table f using fts5(tok,content='',contentless_delete=1,tokenize=\"unicode61 remove_diacritics 0\")")


def q_expr(q, mode, op):
    t = list(dict.fromkeys(toks(q, mode, query=True)))
    if not t:
        return ""
    return f" {op} ".join('"' + x + '"' for x in t)


def run(con, e, topk=100):
    if not e:
        return []
    return [r[0] for r in con.execute("select rowid from f where f match ? order by bm25(f) limit ?", (e, topk))]


def search(con, q, mode, k=10):
    a = run(con, q_expr(q, mode, "AND"))
    if len(a) >= k:  # AND 결과가 충분하면 끝
        return a
    return a + [x for x in run(con, q_expr(q, mode, "OR")) if x not in a]


def ndcg(ranked, rel, pos, k=10):
    rs = {pos[r] for r in rel if r in pos}
    dcg = sum(1 / math.log2(i + 2) for i, x in enumerate(ranked[:k]) if x in rs)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(rs), k)))
    return dcg / ideal if ideal else 0


ALIAS = {"숏츠": ["쇼츠", "shorts"], "쇼츠": ["숏츠", "shorts"], "클로드코드": ["클로드 코드", "claude code"], "8천": ["8000"], "gpt5.5": ["gpt-5.5"]}

CORPUS = [("d1", "YPP 신규 진입 기준은 8,000시간으로 올라간다."), ("d2", "유튜브 쇼츠의 수익 배분은 45%다."), ("d3", "앱을 설치하면 알림을 받을 수 있다."), ("d4", "Claude Code 2.1.314에서 --dump-json 옵션이 추가됐다."),
          ("d5", "C++ 코드를 빌드한다."), ("d6", "C# 과 .NET 런타임을 쓴다."), ("d7", "GPT-5.5 모델은 2026-10-01에 공개됐다."), ("d8", "유튜브API 할당량은 하루 10,000단위다."), ("d9", "클로드 코드의 훅 설정"), ("d10", "숏폼 영상과 쇼츠 알고리즘"), ("d11", "search.list 호출은 하루 100회다."), ("d12", "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS 값을 0으로 둔다.")]
CASES = [("8000시간", "d1"), ("8,000시간", "d1"), ("8천시간", "d1"), ("유튜브쇼츠", "d2"), ("쇼츠의 수익", "d2"), ("쇼츠 수익은", "d2"), ("앱", "d3"), ("앱 설치", "d3"), ("--dump-json", "d4"), ("dump_json", "d4"), ("2.1.314", "d4"), ("314", "d4"), ("C++", "d5"), ("C#", "d6"), (".NET", "d6"), ("GPT-5.5", "d7"), ("GPT5.5", "d7"), ("유튜브 API", "d8"), ("Claude Code 훅", "d9"), ("클로드코드", "d9"), ("숏츠", "d10"), ("search.list", "d11"), ("searchlist", "d11"), ("PRINT_BG_WAIT", "d12"), ("CEILING", "d12"), ("훅", "d9")]


def expand(q):
    out = [q]
    for k, vs in ALIAS.items():
        if k in norm(q):
            out.extend(norm(q).replace(k, v) for v in vs)
    return out


def attack(mode, use_alias):
    c = sqlite3.connect(":memory:")
    ddl(c)
    for i, (d, t) in enumerate(CORPUS):
        c.execute("insert into f(rowid,tok) values(?,?)", (i + 1, " ".join(toks(t, mode))))
    miss = []
    for q, want in CASES:
        r = []
        for qq in (expand(q) if use_alias else [q]):
            r += [x for x in search(c, qq, mode, 5) if x not in r]
        names = [CORPUS[x - 1][0] for x in r[:5]]
        if want not in names:
            miss.append(q)
    return miss


def main():
    base = sys.argv[1]
    docs = json.load(open(f"{base}/docs.json"))
    qs = json.load(open(f"{base}/queries.json"))
    ids = [d["id"] for d in docs]
    pos = {d: i + 1 for i, d in enumerate(ids)}
    res = {}
    for mode in ("base", "fix"):
        c = sqlite3.connect(":memory:")
        ddl(c)
        t0 = time.perf_counter()
        ntok = 0
        rows = []
        for i, d in enumerate(docs):
            tk = toks(d["text"], mode)
            ntok += len(tk)
            rows.append((i + 1, " ".join(tk)))
        c.executemany("insert into f(rowid,tok) values(?,?)", rows)
        c.commit()
        c.execute("insert into f(f) values('optimize')")
        sz = c.execute("select sum(pgsize) from dbstat").fetchone()[0] if False else None
        size = sum(len(r[0]) for r in c.execute("select block from f_data"))
        idx = time.perf_counter() - t0
        s = {"AND+OR": 0.0, "OR": 0.0}
        h = 0
        emp = 0
        lat = []
        for q in qs:
            t = time.perf_counter()
            r = search(c, q["q"], mode)
            lat.append((time.perf_counter() - t) * 1e3)
            s["AND+OR"] += ndcg(r, q["rel"], pos)
            emp += not r
            h += any(pos.get(x) in r[:10] for x in q["rel"])
            s["OR"] += ndcg(run(c, q_expr(q["q"], mode, "OR")), q["rel"], pos)
        lat.sort()
        res[mode] = {"docs": len(docs), "queries": len(qs), "tokens": ntok, "fts_MB": round(size / 1e6, 2), "ndcg_AND_OR": round(s["AND+OR"] / len(qs), 4), "ndcg_OR": round(s["OR"] / len(qs), 4), "hit10": round(h / len(qs), 3), "empty": emp, "p95_ms": round(lat[int(len(lat) * 0.95)], 2)}
    print(json.dumps(res, ensure_ascii=False))
    for mode in ("base", "fix"):
        for al in (False, True):
            m = attack(mode, al)
            print(mode, "alias" if al else "noalias", "miss", len(m), "/", len(CASES), m)


main()
