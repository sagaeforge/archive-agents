"""계약 3장 YAML을 파싱하고 JSON 예시를 스키마로 검증한다. 대상 문서를 수정하지 않는다."""
import json, re, sys, pathlib, base64
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

DOC = pathlib.Path("/home/<user>/sagae-knowloge-base/docs/contracts/data-interface-v0.md")
text = DOC.read_text(encoding="utf-8")

blocks = re.findall(r"```(\w+)\n(.*?)```", text, re.S)
yaml_blocks = [b for k, b in blocks if k == "yaml"]
json_blocks = [(i, b) for i, (k, b) in enumerate(blocks) if k == "json"]
print("code blocks:", {k: sum(1 for x, _ in blocks if x == k) for k in set(x for x, _ in blocks)})

schemas = yaml.safe_load(yaml_blocks[0])
print("schemas defined:", list(schemas))

# 1. flow mapping 쉼표 문제
for name in ("start", "end"):
    print("Evidence.%s ->" % name, schemas["Evidence"]["properties"][name])

# 2. JSON 파싱
parsed = []
for idx, b in json_blocks:
    try:
        parsed.append((idx, json.loads(b)))
    except Exception as e:
        print("JSON parse fail block", idx, repr(b[:70]), e)
print("json ok:", len(parsed), "of", len(json_blocks))

# 3. 스키마 등록
doc = {"components": {"schemas": schemas}}
res = Resource(contents=doc, specification=DRAFT202012)
reg = Registry().with_resource("urn:c", res)


def v(name):
    return Draft202012Validator({"$ref": f"urn:c#/components/schemas/{name}"}, registry=reg)


def errs(name, inst):
    return [f"{'/'.join(map(str, e.absolute_path)) or '.'}: {e.message[:110]}" for e in v(name).iter_errors(inst)]


for name in schemas:
    Draft202012Validator.check_schema(schemas[name])
print("check_schema ok")


def find(pred):
    return [o for _, o in parsed if pred(o)]


env = find(lambda o: "schema_version" in o and "data" in o)
print("\n[Envelope] full envelopes:", len(env))
for o in env:
    print(" ", errs("Envelope", o) or "ok")

print("\n[부분 봉투 예시] data만 있고 봉투 필수 필드가 빠진 예시")
for _, o in parsed:
    if isinstance(o, dict) and "data" in o and "schema_version" not in o:
        print("  keys", list(o)[:4], "data keys", list(o["data"])[:6], "->", len(errs("Envelope", o)), "errors")

print("\n[Node /v1/nodes items]")
nodes_ex = find(lambda o: isinstance(o.get("data"), dict) and "items" in o["data"] and o["data"]["items"] and str(o["data"]["items"][0].get("id", "")).startswith("e:"))
for o in nodes_ex:
    for it in o["data"]["items"]:
        print(" ", errs("Node", it) or "ok")

print("\n[Node detail + claims + evidence /v1/nodes/{id}]")
det = find(lambda o: isinstance(o.get("data"), dict) and "claims" in o["data"])
for o in det:
    d = o["data"]
    print("  node:", errs("Node", d) or "ok")
    for c in d["claims"]:
        print("  claim:", errs("Claim", c) or "ok")
        for ev in c.get("evidence", []):
            print("  evidence:", errs("Evidence", ev) or "ok")
    for e in d["edges"]["out"]:
        print("  edges.out item as Edge:", errs("Edge", e) or "ok")

print("\n[history chain items as Claim]")
hist = find(lambda o: isinstance(o.get("data"), dict) and "chain" in o["data"])
for o in hist:
    for c in o["data"]["chain"]:
        print("  chain:", errs("Claim", c)[:9])
    for e in o["data"]["edges"]:
        print("  edge:", errs("Edge", e))

print("\n[cursor 디코드]")
for cur in ("eyJzIjoxODM0MjJ9",):
    print(" ", cur, "->", base64.urlsafe_b64decode(cur + "=" * (-len(cur) % 4)))

print("\n[search highlight 예시 검증]")
s = find(lambda o: isinstance(o.get("data"), dict) and "items" in o["data"] and o["data"]["items"] and "snippet" in o["data"]["items"][0])
for o in s:
    it = o["data"]["items"][0]
    sn = it["snippet"]
    for h in it["highlights"]:
        print(" ", h, repr(sn[h["start"]:h["end"]]))

print("\n[evidence 오프셋 길이]")
for o in det:
    ev = o["data"]["claims"][0]["evidence"][0]
    print("  len(exact)=", len(ev["exact"]), "end-start=", ev["end"] - ev["start"])
