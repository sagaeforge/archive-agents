import sys, time, unicodedata, re, pathlib, statistics
def hangul_ratio(s):
    h = sum(1 for c in s if '가' <= c <= '힣')
    return h, h/max(1,len(s))
def bad(s):
    # 대체 문자, 사설 영역, cid 표기
    return s.count('�') + sum(1 for c in s if 0xE000 <= ord(c) <= 0xF8FF) + len(re.findall(r'\(cid:\d+\)', s))
def r_pypdf(p):
    import pypdf
    return "\n".join((pg.extract_text() or "") for pg in pypdf.PdfReader(p).pages)
def r_pdfium(p):
    import pypdfium2 as pdfium
    d = pdfium.PdfDocument(p); out=[]
    for i in range(len(d)):
        tp = d[i].get_textpage(); out.append(tp.get_text_range()); tp.close()
    d.close()
    return "\n".join(out)
def r_miner(p):
    from pdfminer.high_level import extract_text
    return extract_text(p)
for f in sys.argv[1:]:
    print("==", pathlib.Path(f).name)
    res={}
    for name, fn in (("pypdf", r_pypdf), ("pypdfium2", r_pdfium), ("pdfminer.six", r_miner)):
        t=time.perf_counter()
        try:
            s=fn(f); dt=time.perf_counter()-t
            s=unicodedata.normalize("NFC", s); res[name]=s
            h,rt=hangul_ratio(s)
            print(f"{name:13s} chars={len(s):7d} hangul={h:6d} ratio={rt:.2f} bad={bad(s):5d} t={dt:.2f}s")
        except Exception as e:
            print(name,"EXC",type(e).__name__,e)
    for name,s in res.items():
        m=re.search(r'.{0,0}[가-힣][^\n]{25,70}', s)
        print(" ",name,"sample:",repr(m.group(0)[:70]) if m else None)
