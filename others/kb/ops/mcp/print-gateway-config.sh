#!/usr/bin/env bash
# print-gateway-config.sh: sagae-tools 관제 서버(tower) 설정의 upstreams.kb 조각을 JSON으로 낸다(ADR 15.4 선택지 B).
# 전역 파일을 건드리지 않는다. mcpServers 래퍼와 type을 쓰지 않는다.
# autoApprove는 읽기 도구 6개이고 kb_put, kb_request는 호출마다 확인을 받는다.
set -euo pipefail
KB_MCP="${KB_MCP_BIN:-/home/user/sagae-kb-data/runtime/bin/kb-mcp}"
python3 -I - "$KB_MCP" <<'P'
import json, sys
cfg = {"upstreams": {"kb": {
    "command": sys.argv[1],
    "args": [],
    "env": {"KB_MCP_SESSION": "tower", "KB_MCP_SUPERVISED": "1"},
    "uriPrefixes": ["kb://"],
    "autoApprove": ["kb_search", "kb_get", "kb_related", "kb_history", "kb_source", "kb_status"],
}}}
print(json.dumps(cfg, ensure_ascii=False, indent=2))
P
