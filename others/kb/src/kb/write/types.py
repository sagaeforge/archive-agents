"""타입과 술어 등록(schemas/types, schemas/predicates.yaml, schemas/predicates.d).

- schemas/types/*.json: 노드 타입은 props의 JSON Schema(2020-12)이고 x-kb-* 키를 더한다.
  x-kb-kind(node|edge), x-kb-group, x-kb-overview, x-kb-version. 엣지 타입 파일은 edge-<이름>.json이다.
- x-kb-overview가 없으면 사용자 타입(group=user)과 provisional로 새로 등록된 사용자 타입은 true, 그 밖은 false로 본다.
- sync_schema()가 schema.type_defined, schema.predicate_defined 이벤트를 쓴다. 내용이 같으면 쓰지 않는다.
"""
from __future__ import annotations

import copy
import json
import re
import time
from pathlib import Path

from kb.core import ledger, paths
from kb.core.canon import canon_json, sha256_hex
from kb.write.errors import WriteRejected

TYPE_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
SYNC_ACTOR = "system:schema-sync"
FIRST_PARTY_TYPES = frozenset({"Page", "Note", "TopicSpec", "Review"})


def normalize_first_party(rec: dict, rid: str, *, existing_props: dict | None = None) -> dict:
    """ADR-0005 3.6/4.2 기본값. FW3는 ID 확정 뒤 호출하고 PUT에는 기존 props를 준다.

    저장이나 충돌 판정은 하지 않으며 입력을 바꾸지 않는다.
    """
    from kb.write.validate import validate_props

    if not isinstance(rec, dict) or not isinstance(rec.get("type"), str) or rec["type"] not in FIRST_PARTY_TYPES:
        raise WriteRejected("schema_invalid", "정의된 first_party 타입이 필요하다")
    out = copy.deepcopy(rec)
    out.setdefault("sensitivity", "private")
    if out["sensitivity"] not in ("public", "internal", "private"):
        raise WriteRejected("schema_invalid", "민감도 형식 위반")
    props = out.setdefault("props", {})
    if not isinstance(props, dict):
        raise WriteRejected("schema_invalid", "props는 객체")
    if out["type"] == "TopicSpec":
        if "slug" not in props:
            props["slug"] = (existing_props or {}).get("slug")
            if props["slug"] is None:
                props["slug"] = "t-" + sha256_hex("kb-topic-slug-v1\0" + rid)[:16]
        private = out["sensitivity"] == "private"
        props.setdefault("export_llm", False)
        props.setdefault("export_query", not private)
        if private and (props["export_llm"] is not False or props["export_query"] is not False):
            raise WriteRejected("schema_invalid", "private의 외부 전송은 허용하지 않는다")
    validate_props(node_types()[out["type"]], props, out["type"])
    return out


def types_dir() -> Path:
    return paths.share_dir() / "schemas" / "types"


def load_type_files() -> dict[tuple[str, str], dict]:
    """(이름, kind) -> 파일 내용. 파일이 깨졌으면 ValueError."""
    out: dict[tuple[str, str], dict] = {}
    d = types_dir()
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        s = json.loads(p.read_text(encoding="utf-8"))
        kind = s.get("x-kb-kind", "node")
        if kind not in ("node", "edge"):
            raise ValueError(f"{p.name}: x-kb-kind {kind!r}")
        name = s.get("title") or p.stem
        out[(name, kind)] = s
    return out


_CACHE: dict = {"at": 0.0, "dir": None, "val": {}}
TTL_S = 2.0


def node_types() -> dict[str, dict]:
    """노드 타입 파일. 쓰기마다 52개 파일을 다시 읽지 않도록 2초 캐시한다(디렉터리가 바뀌어도 최대 2초 늦다)."""
    d = types_dir()
    now = time.monotonic()
    if _CACHE["dir"] == d and now - _CACHE["at"] < TTL_S:
        return _CACHE["val"]
    val = {n: s for (n, k), s in load_type_files().items() if k == "node"}
    _CACHE.update(at=now, dir=d, val=val)
    return val


def in_overview(schema: dict | None, group: str | None) -> bool:
    if schema and "x-kb-overview" in schema:
        return bool(schema["x-kb-overview"])
    g = (schema or {}).get("x-kb-group", group)
    return g == "user"


def type_event_payload(name: str, kind: str, schema: dict, version: int, status: str = "active") -> dict:
    return {"name": name, "kind": kind, "version": version, "schema_json": schema, "status": status}


def provisional_event(type_name: str) -> dict:
    """모르는 타입의 임시 등록. 새 사용자 타입이라 개요 기본에 든다."""
    schema = {"x-kb-kind": "node", "x-kb-group": "user", "x-kb-overview": True, "type": "object",
              "additionalProperties": True}
    return {"kind": "schema.type_defined", "actor": SYNC_ACTOR, "origin": "system", "subject": f"type:{type_name}",
            "idem_key": f"schema.type:{type_name}:provisional", "payload": type_event_payload(
                type_name, "node", schema, 1, "provisional")}


def defined_in_ledger(c, type_name: str) -> dict | None:
    """원장에 등록된 가장 최근 정의(payload) 또는 None."""
    row = c.execute("SELECT payload_sha FROM event WHERE subject=? AND kind='schema.type_defined' "
                    "ORDER BY seq DESC LIMIT 1", (f"type:{type_name}",)).fetchone()
    return ledger.get_payload(c, row[0]) if row else None


def type_schema(c, type_name: str) -> dict | None:
    """타입의 props 스키마. 파일이 있으면 파일, 없으면 원장 정의. 모르는 타입이면 None."""
    s = node_types().get(type_name)
    if s is not None:
        return s
    d = defined_in_ledger(c, type_name)
    return d.get("schema_json") if d else None


def known(c, type_name: str) -> bool:
    return type_name in node_types() or defined_in_ledger(c, type_name) is not None


def _read_predicates() -> list[dict]:
    root = paths.share_dir() / "schemas"
    files = [root / "predicates.yaml", *sorted((root / "predicates.d").glob("*.yaml"))] if root.is_dir() else []
    out: list[dict] = []
    for f in files:
        if f.is_file():
            out.extend(_parse_predicates(f.read_text(encoding="utf-8")))
    return out


_LINE = re.compile(r"^\s*-\s*\{(.*)\}\s*$")


def _scalar(v: str):
    v = v.strip().strip("'\"")
    return {"true": True, "false": False}.get(v, v)


def _split_top(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def _parse_predicates(text: str) -> list[dict]:
    """한 줄 흐름 형식 `- {id: x, functional: true, value_kind: y, labels: {ko: .., en: ..}}`만 읽는다.
    pyyaml이 있으면 그것을 쓴다."""
    try:
        import yaml
        d = yaml.safe_load(text) or {}
        return [dict(p) for p in d.get("predicates", [])]
    except ImportError:
        pass
    out = []
    for ln in text.splitlines():
        m = _LINE.match(ln)
        if not m:
            continue
        rec: dict = {}
        for part in _split_top(m.group(1)):
            k, _, v = part.partition(":")
            k, v = k.strip(), v.strip()
            if v.startswith("{"):
                rec[k] = {a.strip(): _scalar(b) for a, _, b in (x.partition(":") for x in v.strip("{} ").split(","))}
            else:
                rec[k] = _scalar(v)
        out.append(rec)
    return out


def predicate_payload(p: dict) -> dict:
    labels = p.get("labels") or {}
    out = {"id": p["id"], "functional": bool(p["functional"]), "value_kind": p["value_kind"]}
    if labels.get("ko"):
        out["label_ko"] = labels["ko"]
    if labels.get("en"):
        out["label_en"] = labels["en"]
    return out


def sync_events(c) -> tuple[list[dict], dict]:
    """쓸 이벤트 목록과 통계. 원장과 같은 내용은 뺀다."""
    evs: list[dict] = []
    stats = {"types_total": 0, "types_written": 0, "predicates_total": 0, "predicates_written": 0}
    for (name, kind), schema in sorted(load_type_files().items()):
        stats["types_total"] += 1
        row = c.execute("SELECT payload_sha FROM event WHERE subject=? AND kind='schema.type_defined' "
                        "ORDER BY seq DESC LIMIT 1", (f"type:{name}" if kind == "node" else f"edge:{name}",)).fetchone()
        prev = ledger.get_payload(c, row[0]) if row else None
        if prev and prev.get("kind") == kind and canon_json(prev.get("schema_json")) == canon_json(schema) \
                and prev.get("status") == "active":
            continue
        version = (prev["version"] + 1) if prev else int(schema.get("x-kb-version", 1))
        sha = sha256_hex(canon_json(schema))[:16]
        subj = f"type:{name}" if kind == "node" else f"edge:{name}"
        evs.append({"kind": "schema.type_defined", "actor": SYNC_ACTOR, "origin": "system", "subject": subj,
                    "idem_key": f"schema.type:{kind}:{name}:v{version}:{sha}",
                    "payload": type_event_payload(name, kind, schema, version)})
        stats["types_written"] += 1
    seen: set[str] = set()
    for p in _read_predicates():
        pl = predicate_payload(p)
        if pl["id"] in seen:
            continue
        seen.add(pl["id"])
        stats["predicates_total"] += 1
        sha = sha256_hex(canon_json(pl))[:16]
        key = f"schema.pred:{pl['id']}:{sha}"
        row = c.execute("SELECT 1 FROM event WHERE idem_key=?", (key,)).fetchone()
        if row:
            continue
        evs.append({"kind": "schema.predicate_defined", "actor": SYNC_ACTOR, "origin": "system",
                    "subject": f"pred:{pl['id']}", "idem_key": key, "payload": pl})
        stats["predicates_written"] += 1
    return evs, stats
