"""test_concurrency가 동시에 띄우는 첫 기동 프로세스. argv: 시작 시각(time.time 초), 표지."""
import sys
import time

from kb.core import ledger, opsdb

time.sleep(max(0.0, float(sys.argv[1]) - time.time()))
tag = sys.argv[2]
c = opsdb.connect()
opsdb.record_metric(c, "race", 1, {"tag": tag})
c.close()
c = ledger.open_ledger()
ledger.append(c, [{"kind": "record.put", "actor": "agent:race", "origin": "first_party", "subject": f"f-{tag}",
                   "idem_key": tag, "payload": {"t": tag}}])
c.close()
