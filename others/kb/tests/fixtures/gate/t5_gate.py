"""T5: 실제 추출 주장 49건의 '문장'만 왜곡하고 인용구는 그대로 둔다. 게이트별 통과를 센다.
quote-only = durability 6.4, platform 8.3(문장을 입력으로 받지 않는다). quote+num = simplicity 7.5, retrieval 8.4 2단계."""
import json, re, sys
rows=json.load(open(sys.argv[1],encoding='utf8'))
NUM=re.compile(r'\d[\d,\.]*\d|\d')
def nums(s): return {x.replace(',','').rstrip('.') for x in NUM.findall(s)}
def num_ok(st,q): return not (nums(st)-nums(q))
NEG=[("포함되지 않는다","포함된다"),("읽지 않는다","읽는다"),("할 수 있다","할 수 없다"),("할 수 없다","할 수 있다"),("필요하다","필요하지 않다"),("있어야 한다","없어도 된다"),("만들어야 한다","만들지 않아도 된다"),("사용하지 않으므로","사용하므로"),("제거했다","도입했다"),("건너뛰어","포함해"),("별도의","공용")]
CMP=[("이상","이하"),("이내","이후"),("최소","최대"),("까지","부터")]
UNIT=[("달러","원"),("시간","분"),("개월","주"),("일 후","주 후"),("일 이내","시간 이내"),("%","포인트"),("억","만")]
SUBJ=[("search.list","videos.list"),("videos.insert","thumbnails.set"),("YPP","네이버 클립"),("유튜브","틱톡"),("--bare","--print"),("Monitor","Bash"),("Agent SDK","MCP SDK"),("구글","메타"),("수전 워치츠키","닐 모한")]
res={}
def add(k,st,q,ex):
    d=res.setdefault(k,dict(n=0,quote_only=0,quote_num=0,examples=[]))
    d['n']+=1; d['quote_only']+=1
    if num_ok(st,q):
        d['quote_num']+=1
        if len(d['examples'])<3: d['examples'].append(ex)
for r in rows:
    s,q=r['statement'],r['quote']
    for name,tbl in (("부정 반전",NEG),("비교 반전",CMP),("단위 교체",UNIT),("주어 교체",SUBJ)):
        for a,b in tbl:
            if a in s:
                t=s.replace(a,b,1); add(name,t,q,(t,q[:60]))
                break
    ns=[m for m in NUM.finditer(s)]
    vals=[m.group(0) for m in ns]
    if len(set(vals))>=2:
        a,b=ns[0],ns[1]
        if a.group(0)!=b.group(0):
            t=s[:a.start()]+b.group(0)+s[a.end():b.start()]+a.group(0)+s[b.end():]
            add("숫자 교차",t,q,(t,q[:60]))
    if ns:
        m=ns[0]; v=m.group(0); nv=v[:-1]+str((int(v[-1])+1)%10)
        t=s[:m.start()]+nv+s[m.end():]; add("숫자 변경(대조군)",t,q,(t,q[:60]))
tot=dict(n=0,quote_only=0,quote_num=0)
for k,d in res.items():
    print(k,d['n'],'quote-only',d['quote_only'],'quote+num',d['quote_num'])
    for e in d['examples'][:2]: print('    S:',e[0],'| Q:',e[1])
    if '대조군' not in k:
        for f in tot: tot[f]+=d[f]
print('왜곡 합계(대조군 제외)',tot)
