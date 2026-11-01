"""강화 게이트 시험. X6 왜곡을 같은 방식으로 만들어 통과 수를 세고, 원래 주장의 보류율을 잰다.
검사는 전부 결정적이다. 값은 인용구에서 기계로 뽑아 문장과 대조한다."""
import json, re, sys, unicodedata
sys.path.insert(0, ".")
from t5_tables import NEG, CMP, UNIT, SUBJ
base = sys.argv[1]
rows = json.load(open(f"{base}/gate_rows.json", encoding="utf8"))
docs = {}
for n in ("headless", "kowiki_yt", "quota", "ypp_ko"):
    docs[n] = unicodedata.normalize("NFC", open(f"{base}/{n}.txt", encoding="utf8").read())
print(list(rows[0].keys()), len(rows))
NUM = re.compile(r"\d[\d,\.]*\d|\d")
WORDNUM = {"one":"1","two":"2","three":"3","four":"4","five":"5","six":"6","seven":"7","eight":"8","nine":"9","ten":"10","twelve":"12"}
def nums(s):
    out = {x.replace(",", "").rstrip(".") for x in NUM.findall(s)}
    for w, v in WORDNUM.items():
        if re.search(rf"\b{w}\b", s, re.I):
            out.add(v)
    return out
HANGUL = re.compile("[가-힣]")
DATE = r"\d[\d,.]*\s*(?:년|월|일|시간|분|주|개월|회|명|달러|원|%|억|만|천|포인트|단계)?\s*"
CONCEPT = {
 "ge": [DATE + r"이상", r"at least", r"or more", r"최소", r"minimum", r"more than"],
 "le": [DATE + r"(?:이하|미만|이내)", r"at most", r"or less", r"최대", r"maximum", r"up to", r"less than", r"within"],
 "after": [DATE + r"(?:부터|이후)", r"\bafter\b", r"\bfrom\b", r"\bsince\b", r"starting"],
 "before": [DATE + r"(?:까지|이전)", r"\bbefore\b", r"\buntil\b", r"\bby\b", r"within"],
 "usd": [r"달러", r"\$", r"USD"], "krw": [r"\d\s*원", r"KRW", r"₩"],
 "hour": [r"\d\s*시간", r"\d\s*hours?\b"], "min": [r"\d\s*분", r"\d[\s-]*minutes?\b"], "day": [r"\d\s*일\b", r"\d\s*일\s", r"\d[\s-]*days?\b"], "week": [r"\d\s*주", r"\d[\s-]*weeks?\b"],
 "month": [r"\d\s*개월", r"\d[\s-]*months?\b"], "year": [r"\d\s*년", r"\d[\s-]*years?\b"],
 "pct": [r"%", r"퍼센트", r"percent"], "eok": [r"\d\s*억", r"billion"], "man": [r"\d\s*만", r"million"],
}
EQUIV = {"after": {"ge"}, "le": {"before"}, "before": {"le"}}
NEGW = [r"않", r"없", r"못", r"불가", r"금지", r"아니", r"\bnot\b", r"\bno\b", r"\bnever\b", r"cannot", r"can't", r"n't\b", r"without", r"unless", r"neither"]
ALIAS = {"ypp": ["youtube 파트너 프로그램", "파트너 프로그램", "ypp"], "--bare": ["--bare", "bare"], "youtube": ["youtube", "유튜브"], "유튜브": ["youtube", "유튜브"], "구글": ["google", "구글"]}
PAIR = re.compile(r"(\d[\d,.]*)\s*([가-힣%]{1,2})")
def concepts(s):
    return {k for k, ps in CONCEPT.items() if any(re.search(p, s, re.I) for p in ps)}
def negp(s):
    return any(re.search(p, s, re.I) for p in NEGW)
def ctx_of(q, d):
    i = d.find(q)
    if i < 0:
        i = d.find(q[:30])
    if i < 0:
        return q
    a = d.rfind("\n\n", 0, i); b = d.find("\n\n", i + len(q))
    return d[:200] + "\n" + d[max(a, 0): b if b > 0 else len(d)]
def pairs(s):
    return {(n.replace(",", "").rstrip("."), u[0]) for n, u in PAIR.findall(s)}
def check(st, q, subj, para, mode):
    why = []
    if nums(st) - nums(q):
        why.append("num")
    if HANGUL.search(q) and (pairs(st) - pairs(q)):
        why.append("pair")
    sc = concepts(st); qc = concepts(q)
    miss = {c for c in sc if c not in qc and not (EQUIV.get(c, set()) & qc)}
    if miss:
        why.append("concept:" + ",".join(sorted(miss)))
    if negp(st) != negp(q):
        why.append("neg")
    if subj:
        low = (q + " " + para).lower()
        toks = [t for t in re.split(r"[\s/()·,]+", subj.lower()) if len(t) >= 2]
        names = [t for t in toks]
        for t in toks:
            names += ALIAS.get(t, [])
        if not any(t in low for t in names):
            why.append("subject")
    return why
def doc_for(r):
    for n, d in docs.items():
        if r["quote"][:30] in d or unicodedata.normalize("NFC", r["quote"])[:30] in d:
            return n
    return None
res = {}
orig_flag = []
for r in rows:
    s, q = r["statement"], r["quote"]
    n = doc_for(r)
    para = ctx_of(q, docs[n]) if n else q
    subj = r.get("subject") or ""
    w = check(s, q, subj, para, "para")
    if w:
        orig_flag.append((s[:50], w))
    def add(k, t, sb=subj):
        d = res.setdefault(k, {"n": 0, "pass": 0, "ex": []})
        d["n"] += 1
        if not check(t, q, sb, para, "para"):
            d["pass"] += 1
            if len(d["ex"]) < 2:
                d["ex"].append(t[:70])
    for name, tbl in (("부정 반전", NEG), ("비교 반전", CMP), ("단위 교체", UNIT)):
        for a, b in tbl:
            if a in s:
                add(name, s.replace(a, b, 1))
                break
    for a, b in SUBJ:
        if a in s:
            add("주어 교체", s.replace(a, b, 1))
            break
    ns = list(NUM.finditer(s))
    if len({m.group(0) for m in ns}) >= 2:
        a, b = ns[0], ns[1]
        if a.group(0) != b.group(0):
            add("숫자 교차", s[:a.start()] + b.group(0) + s[a.end():b.start()] + a.group(0) + s[b.end():])
    if ns:
        m = ns[0]; v = m.group(0)
        add("숫자 변경(대조군)", s[:m.start()] + v[:-1] + str((int(v[-1]) + 1) % 10) + s[m.end():])
tot = [0, 0]
for k, d in res.items():
    print(k, d["n"], "통과", d["pass"], d["ex"])
    if "대조군" not in k:
        tot[0] += d["n"]; tot[1] += d["pass"]
print("왜곡 합계", tot, "| 원래 주장 49건 중 보류", len(orig_flag))
for f in orig_flag[:14]:
    print("  ", f)
