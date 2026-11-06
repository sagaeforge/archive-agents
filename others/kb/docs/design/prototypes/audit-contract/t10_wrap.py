import re, pathlib, yaml, json
t = pathlib.Path("/home/<user>/sagae-knowloge-base/docs/contracts/data-interface-v0.md").read_text(encoding="utf-8")
blk = re.search(r"```yaml\n(.*?)```", t, re.S).group(1)
s = yaml.safe_load(blk)
paths = {}
# 계약 4장 표의 경로
tbl = re.findall(r"^\| `(/v1/[^`]+)`(?:, `(/v1/[^`]+)`)*", t, re.M)
rows = re.findall(r"^\| ((?:`/v1/[^`]+`(?:, )?)+) \|", t, re.M)
eps = []
for r in rows:
    eps += re.findall(r"`(/v1/[^`]+)`", r)
print("계약 표의 엔드포인트 문자열", len(eps))
spec = {"openapi": "3.1.1", "info": {"title": "kb", "version": "0.1.0"}, "paths": {}, "components": {"schemas": s}}
ok_schema = {"/v1/nodes": "Node", "/v1/nodes/{id}": "Node", "/v1/claims/{id}": "Claim", "/v1/edges/{id}": "Edge"}
seen = []
for e in eps:
    if "?" in e or e in spec["paths"] or e.startswith("/v1/snapshots/{id}/") and False:
        pass
    p = e.split("?")[0]
    if p in spec["paths"]:
        continue
    seen.append(p)
    op = {"responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}}}
    params = [{"name": m, "in": "path", "required": True, "schema": {"type": "string"}} for m in re.findall(r"\{(\w+)\}", p)]
    if params:
        op["parameters"] = params
    spec["paths"][p] = {"get": op}
pathlib.Path("openapi.wrap.yaml").write_text(yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), encoding="utf-8")
print("\n".join(seen))
