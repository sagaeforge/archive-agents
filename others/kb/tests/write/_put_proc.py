"""test_idempotent가 띄우는 프로세스: 게이트 파일이 생기면 같은 키로 put_record를 부르고 결과 JSON을 낸다."""
import json
import os
import sys
import time

from kb.write import put_record

key, rec = sys.argv[1], json.loads(sys.argv[2])
go = sys.argv[3]
while not os.path.exists(go):
    time.sleep(0.002)
try:
    r = put_record(rec, key, "mcp", "s-proc")
    print(json.dumps(r.as_dict(), ensure_ascii=False))
except Exception as e:  # noqa: BLE001
    print(json.dumps({"error": type(e).__name__, "message": str(e)}))
    sys.exit(3)
