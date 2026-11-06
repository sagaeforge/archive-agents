"""계약 4.3: 정렬 id 오름차순, limit 10,000, 닫힌 부분 그래프를 추정 규모에 적용한다.
ID 규칙은 ADR 7.5다. 분포는 ADR 부록 A 범위 안의 가정이다(합성). 결과는 분포에 따라 달라지므로 경향만 본다."""
import random, collections, json
rnd = random.Random(7)
# 개요 기본 타입 분포 가정. 합 약 48,000(ADR 추정 2만~5만 안).
dist = {"Repo": 300, "Package": 600, "Feature": 9000, "Tool": 2500, "Model": 1500, "Org": 2500, "Person": 4000,
        "Channel": 1500, "Video": 3000, "Keyword": 8000, "Metric": 1500, "Concept": 7000, "Technique": 2500,
        "Policy": 800, "Platform": 150, "Product": 300}
nodes = []
for t, n in dist.items():
    for i in range(n):
        nodes.append((f"e:{t.lower()}/s{i:06d}", t, "external"))
for t, n in {"Note": 1200, "Decision": 200, "Artifact": 200, "Learning": 300, "Project": 20}.items():
    for i in range(n):
        nodes.append((f"f-{rnd.getrandbits(64):016x}", t, "first_party"))
byt = collections.defaultdict(list)
for x in nodes:
    byt[x[1]].append(x[0])
edges = []
def add(st, rt, dt, n):
    for _ in range(n):
        edges.append((rnd.choice(byt[st]), rt, rnd.choice(byt[dt])))
# 계약 예시와 같은 구조: Feature PART_OF Product, Product RUNS_ON Platform, 사실 투영 등
add("Feature", "PART_OF", "Product", 9000)
add("Feature", "USES", "Tool", 6000)
add("Package", "DEPENDS_ON", "Package", 3000)
add("Repo", "PART_OF", "Org", 300)
add("Person", "PART_OF", "Org", 4000)
add("Video", "PUBLISHED_BY", "Channel", 3000)
add("Keyword", "MEASURES", "Video", 5000)
add("Concept", "USES", "Technique", 20000)
add("Model", "PART_OF", "Org", 1500)
add("Tool", "RUNS_ON", "Platform", 2500)
add("Note", "LINKS_TO", "Feature", 3000)
add("Decision", "LINKS_TO", "Product", 400)
add("Feature", "removed_in", "Product", 40000)
add("Concept", "MENTIONS", "Keyword", 60000)
add("Product", "RUNS_ON", "Platform", 300)
print("전체 노드", len(nodes), "엣지", len(edges))

nodes.sort()
for lim, elim in ((10000, 50000), (20000, 100000)):
    kept = nodes[:lim]
    ks = {x[0] for x in kept}
    types = collections.Counter(x[1] for x in kept)
    closed = [e for e in edges if e[0] in ks and e[2] in ks]
    print(f"\nlimit={lim}: 포함 타입 {dict(types)}")
    print(f"  first_party 포함 {sum(1 for x in kept if x[2]=='first_party')}건 / 전체 1920건")
    print(f"  닫힌 엣지 {len(closed)} / {len(edges)} = {len(closed)/len(edges)*100:.1f}%, 엣지 타입 {dict(collections.Counter(e[1] for e in closed))}")
print("\n참고: 정렬 키가 ID이므로 타입 이름 알파벳 순서가 곧 절단 순서다. 첫 타입 경계:",
      [ (t, min(i for i,x in enumerate(nodes) if x[1]==t)) for t in ("Channel","Concept","Feature","Keyword","Org","Product","Repo","Video","Note") ])
