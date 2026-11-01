"""kb put -f record.json --key K | kb put --tombstone <id> --reason R --key K"""
from __future__ import annotations

import json
import sys

from kb.write.cliutil import emit, fail, guarded
from kb.write import record


def _load(path: str) -> dict:
    raw = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def cmd_put(args) -> int:
    def run() -> int:
        if args.tombstone:
            if not args.key or not args.reason:
                return fail("schema_invalid", "--tombstone에는 --key와 --reason이 필요하다", args.json)
            r = record.tombstone_record(args.tombstone, args.reason, args.key, "cli")
        else:
            if not args.file:
                return fail("schema_invalid", "-f <파일>이 필요하다", args.json)
            try:
                obj = _load(args.file)
            except (OSError, ValueError) as e:
                return fail("schema_invalid", f"입력을 읽지 못함: {e}", args.json)
            if isinstance(obj, dict) and "record" in obj:  # 계약 6.1 형식
                key = args.key or obj.get("idempotency_key")
                rec = obj["record"]
                extra = sorted(set(obj) - {"record", "idempotency_key"})
                if extra:
                    return fail("schema_invalid", f"허용하지 않는 필드: {extra}", args.json)
            else:
                key, rec = args.key, obj
            if not key:
                return fail("schema_invalid", "멱등 키가 필요하다(--key 또는 idempotency_key)", args.json)
            r = record.put_record(rec, key, "cli")
        emit(r.as_dict(), args.json)
        return 0
    return guarded(run, args.json)


def register(sub) -> None:
    p = sub.add_parser("put", help="first_party 레코드 쓰기(TTY면 user:sagae, 아니면 agent:cli)")
    p.add_argument("-f", "--file", help="record JSON 파일. -는 표준입력")
    p.add_argument("--key", help="멱등 키")
    p.add_argument("--tombstone", metavar="ID", help="레코드를 기본 읽기에서 내린다")
    p.add_argument("--reason", help="--tombstone 사유")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_put)
