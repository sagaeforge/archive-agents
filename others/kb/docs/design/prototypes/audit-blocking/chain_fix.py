"""D8을 ADR 7.1 DDL과 체인 입력 그대로 다시 잰다. 1비트 플립 300회.
검증기는 ADR 체인 입력 + payload 본문 sha 대조 + integrity_check 합산이다(ADR보다 후하게 잡았다)."""
import hashlib, json, os, random, sqlite3, sys, shutil
from pathlib import Path
root=Path(sys.argv[1]); shutil.rmtree(root,ignore_errors=True); root.mkdir(parents=True)
N=int(sys.argv[2]); TR=int(sys.argv[3])
DDL="""
CREATE TABLE event(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, v INT NOT NULL, at INT NOT NULL, actor TEXT NOT NULL,
  on_behalf_of TEXT, generated_by TEXT, origin TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, idem_key TEXT NOT NULL UNIQUE,
  payload_sha TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE payload(sha TEXT PRIMARY KEY, body BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE record_head(id TEXT PRIMARY KEY, version INT NOT NULL, content_sha TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
"""
GEN="0"*64
sha=lambda b: hashlib.sha256(b).hexdigest()
def chain_in(prev,seq,eid,v,at,actor,obo,gen,origin,kind,subj,idem,psha):
    return "\n".join([prev,str(seq),eid,str(v),str(at),actor,str(obo),str(gen),origin,kind,str(subj),idem,psha]).encode()
p=root/"ledger.db"; c=sqlite3.connect(p,isolation_level=None); c.executescript(DDL); c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA synchronous=OFF")
c.execute("INSERT INTO meta VALUES('epoch','1')"); c.execute("INSERT INTO meta VALUES('fp_open','1')")
rnd=random.Random(5); prev=GEN; at=1793000000000
c.execute("BEGIN")
for i in range(1,N+1):
    rid=f"f-{i%800:04d}"; body=json.dumps({"id":rid,"title":f"기록 {i}","body":"유튜브 쇼츠 수익 배분 메모 "*3},sort_keys=True,ensure_ascii=False).encode()
    ps=sha(body); eid=hashlib.sha256(str(i).encode()).hexdigest()[:32]; at+=rnd.randrange(1,50)
    actor="agent:s1"; origin="first_party"; kind="record.put"
    h=sha(chain_in(prev,i,eid,1,at,actor,"user:sagae","kb-mcp@1",origin,kind,f"e:record/{rid}",f"idem-{i}",ps))
    c.execute("INSERT OR IGNORE INTO payload VALUES(?,?)",(ps,body))
    c.execute("INSERT INTO event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(i,eid,1,at,actor,"user:sagae","kb-mcp@1",origin,kind,f"e:record/{rid}",f"idem-{i}",ps,prev,h))
    c.execute("INSERT INTO record_head VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=version+1,content_sha=excluded.content_sha",(rid,1,ps))
    prev=h
c.execute("COMMIT"); c.execute("PRAGMA wal_checkpoint(TRUNCATE)"); c.close()
TABLES={"event":"SELECT * FROM event ORDER BY seq","payload":"SELECT * FROM payload ORDER BY sha","record_head":"SELECT * FROM record_head ORDER BY id","meta":"SELECT * FROM meta ORDER BY k"}
COLS=["seq","event_id","v","at","actor","on_behalf_of","generated_by","origin","kind","subject","idem_key","payload_sha","prev_hash","hash"]
def dump(c): return {k:c.execute(q).fetchall() for k,q in TABLES.items()}
c=sqlite3.connect(p); base=dump(c); c.close()
def chain_bad(c):
    pv=GEN
    heads={}
    for seq,eid,v,at,actor,obo,gen,origin,kind,subj,idem,ps,ph,hh in c.execute("SELECT seq,event_id,v,at,actor,on_behalf_of,generated_by,origin,kind,subject,idem_key,payload_sha,prev_hash,hash FROM event ORDER BY seq"):
        if ph!=pv or sha(chain_in(ph,seq,eid,v,at,actor,obo,gen,origin,kind,subj,idem,ps))!=hh: return True
        pv=hh; rid=subj.split("/",1)[1]; x=heads.get(rid,(0,None)); heads[rid]=(x[0]+1,ps)
    if {r:(a,b) for r,a,b in c.execute("SELECT id,version,content_sha FROM record_head")}!=heads: return True
    if dict(c.execute("SELECT k,v FROM meta"))!={"epoch":"1","fp_open":"1"}: return True
    for s,b in c.execute("SELECT sha,body FROM payload"):
        if sha(bytes(b) if isinstance(b,(bytes,memoryview)) else str(b).encode())!=s: return True
    # 모든 이벤트의 payload_sha가 payload에 있는가
    n=c.execute("SELECT count(*) FROM event e LEFT JOIN payload p ON p.sha=e.payload_sha WHERE p.sha IS NULL").fetchone()[0]
    return n>0
data=p.read_bytes(); rng=random.Random(5)
st=dict(trials=0,integrity_only=0,chain_only=0,both=0,neither_same=0,neither_diff=0,err=0,n=N,db_mb=round(len(data)/1e6,2)); where={}; ex=[]
fp=root/"f.db"
for t in range(TR):
    b=bytearray(data); off=rng.randrange(8192,len(b)); b[off]^=1<<rng.randrange(8); fp.write_bytes(b); st["trials"]+=1
    ic=False; cb=False; c=None
    try:
        c=sqlite3.connect(fp,isolation_level=None); ic=c.execute("PRAGMA integrity_check").fetchone()[0]!="ok"
    except sqlite3.Error: st["err"]+=1; ic=True
    try: cb=chain_bad(c)
    except Exception: cb=True
    if ic and cb: st["both"]+=1
    elif ic: st["integrity_only"]+=1
    elif cb: st["chain_only"]+=1
    else:
        try: d=dump(c)
        except Exception: d=None
        if d==base: st["neither_same"]+=1
        else:
            st["neither_diff"]+=1
            key="?"
            for k in TABLES:
                if d and d[k]!=base[k]:
                    for x,y in zip(d[k],base[k]):
                        if x!=y:
                            cols=[COLS[i] if k=="event" else str(i) for i,(u,v) in enumerate(zip(x,y)) if u!=v]
                            key=f"{k}.{','.join(cols)}"
                            if len(ex)<6: ex.append((key,[str(u)[:40] for u,v in zip(x,y) if u!=v],[str(v)[:40] for u,v in zip(x,y) if u!=v]))
                            break
                    break
            where[key]=where.get(key,0)+1
    if c: c.close()
    for s in ("","-wal","-shm"): Path(str(fp)+s).unlink(missing_ok=True)
print(json.dumps(st,ensure_ascii=False)); print(json.dumps(where,ensure_ascii=False)); print(json.dumps(ex,ensure_ascii=False))
shutil.rmtree(root)
