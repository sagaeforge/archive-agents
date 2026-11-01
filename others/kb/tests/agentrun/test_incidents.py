"""incidents는 모든 에이전트 스키마·워크플로우 반환값의 필수 필드이고, 스트림의 사고는 ops.db와 ndjson에 기록되어 kb status critical에 나온다."""
import json
import re

from arhelp import FIX, REPO
from kb.agentrun import record, stream

SCHEMAS = sorted((REPO / "schemas" / "agent").glob("*.schema.json"))
WORKFLOWS = sorted((REPO / ".claude" / "workflows").glob("*.js"))


def test_every_agent_schema_requires_incidents():
    assert len(SCHEMAS) >= 8
    for p in SCHEMAS:
        d = json.load(open(p, encoding="utf-8"))
        if p.name == "incidents.schema.json":  # 공유 정의: 배열 항목 스키마
            assert d["type"] == "array" and set(d["items"]["required"]) == {"kind", "detail"}
            assert set(d["items"]["properties"]["kind"]["enum"]) == {"external_send", "global_file_change", "data_loss", "agent_lost", "other"}
            continue
        assert "incidents" in d["required"] and "incidents" in d["properties"], p.name


def test_every_workflow_return_and_schema_has_incidents():
    assert len(WORKFLOWS) == 4
    for p in WORKFLOWS:
        src = p.read_text(encoding="utf-8")
        schemas = re.findall(r"const \w+ = \{ type: 'object', required: \[([^\]]*)\]", src)
        assert schemas and all("'incidents'" in s for s in schemas), p.name
        assert "INC_SCHEMA" in src and "agent_lost" in src and "log('INCIDENT '" in src, p.name
        starts = [m.start() for m in re.finditer(r"return \{\s*workflow: '", src)]   # 워크플로우 반환값(내부 보조 return 제외)
        assert starts, p.name
        for a in starts:
            seg = src[a:].split("\n}\n")[0].split("\nreturn ")[0]
            assert "incidents" in seg, (p.name, seg[:80])


def test_stream_incidents_recorded_and_critical(home):
    from kb.guard import status
    evs = list(stream.parse_lines(open(FIX / "stream-incidents.ndjson", encoding="utf-8")))
    found = [i for e in evs for i in stream.incidents_in(e)]
    assert {i["kind"] for i in found} == {"external_send", "agent_lost"}
    for i in found:
        record.write_incident("kb-fulfill", i)
    rows = [json.loads(x) for x in record.ndjson_path().read_text().splitlines()]
    assert len(rows) == 2 and all(r["job"] == "kb-fulfill" for r in rows)
    st = status.build()
    assert any(c["code"] == "incident_open" for c in st["critical"]), st["critical"]
    assert st["incidents"]["open"] == 2
