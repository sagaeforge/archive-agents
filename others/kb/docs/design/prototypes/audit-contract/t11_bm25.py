"""검색 커서: (bm25, rowid) 키셋이 페이지 사이 삽입에 안정한가. 합성."""
import sqlite3, random
c = sqlite3.connect(":memory:")
c.execute("CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 0\")")
rnd = random.Random(3)
V = [f"t{i}" for i in range(60)]
for i in range(1, 2001):
    n = rnd.randrange(8, 40)
    toks = rnd.choices(V, k=n) + (["광고"] * rnd.randrange(1, 4) if i % 3 == 0 else [])
    c.execute("INSERT INTO fts(rowid,tok) VALUES(?,?)", (i, " ".join(toks)))
def top(k=20, after=None):
    if after is None:
        return c.execute("SELECT rowid, bm25(fts) b FROM fts WHERE fts MATCH '광고' ORDER BY b, rowid LIMIT ?", (k,)).fetchall()
    return c.execute("WITH x AS MATERIALIZED (SELECT rowid r, bm25(fts) b FROM fts WHERE fts MATCH '광고') SELECT r, b FROM x WHERE (b, r) > (?,?) ORDER BY b, r LIMIT ?", (after[1], after[0], k)).fetchall()
p1 = top()
ctl = top(20, after=p1[-1])
print('대조군(삽입 없음): 2쪽', len(ctl), '겹침', len({r for r,_ in p1} & {r for r,_ in ctl}))
before = {r: b for r, b in top(10000)}
for i in range(5000, 5300):  # 페이지 사이 적재 300건
    c.execute("INSERT INTO fts(rowid,tok) VALUES(?,?)", (i, " ".join(rnd.choices(V, k=20) + ["광고"] * rnd.randrange(1, 3))))
p2 = top(after=p1[-1])
after_rank = top(10000)
ids_old = {r for r in before}
order_new = [r for r, _ in after_rank if r in ids_old]
pos1 = [r for r, _ in p1]
print("1쪽 마지막 bm25:", round(p1[-1][1], 5))
print("같은 문서의 bm25 변화:", round(before[p1[0][0]], 5), "->", round(dict(after_rank)[p1[0][0]], 5))
# 키셋 페이지(1쪽 + 2쪽)와 새 순위 앞부분 비교
seen = pos1 + [r for r, _ in p2]
new_top = [r for r, _ in after_rank][:len(seen)]
print("1+2쪽 고유", len(set(seen)), "중복", len(seen) - len(set(seen)), "| 새 순위 상위 40 중 1+2쪽에 없는 것", len(set(new_top) - set(seen)))

print("2쪽 건수", len(p2), "1쪽과 겹침", len(set(pos1) & {r for r, _ in p2}))
print("2쪽 앞 5개가 삽입 후 전체 순위에서 몇 위인가", [[r for r,_ in after_rank].index(x) for x,_ in p2[:5]])
