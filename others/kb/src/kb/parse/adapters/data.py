"""표 형식 데이터 어댑터: csv, hf_models, mcp_registry, kworb, codex_features."""
from __future__ import annotations

import csv
import io
import re

from kb.core import ids
from kb.parse.adapters import adapter
from kb.parse.adapters._common import csv_prose, day_points, doc_entity
from kb.parse.model import Claim, Edge, Entity, Result, Series, pointer, ptr_escape, quote, slugify


def _col(header: list[str], want: str | None, default: int | None) -> int | None:
    if want:
        for i, h in enumerate(header):
            if h.strip().lower() == want.strip().lower():
                return i
    return default if default is not None and default < len(header) else None


@adapter("csv", hint="text", prose=csv_prose)
def csv_rows(ctx) -> Result:
    """행마다 엔티티. cfg: label(열 이름), link(열 이름), type(기본 Tool), prefix, active(열 이름, TRUE만),
    prose(산문 열 이름 목록. `l2: declared`일 때 그 칸만 L2로 간다, ADR-0004 D1)."""
    cfg = ctx.cfg or {}
    rows = list(csv.reader(io.StringIO(ctx.text.text)))
    res = Result()
    if len(rows) < 2:
        res.notes.append("empty_csv")
        res.count = 0
        return res
    hdr = rows[0]
    li, ui = _col(hdr, cfg.get("label"), 1), _col(hdr, cfg.get("link"), 4)
    ai = _col(hdr, cfg.get("active"), None) if cfg.get("active") else None
    typ, prefix = str(cfg.get("type", "Tool")), str(cfg.get("prefix", "row"))
    n = 0
    for r in rows[1:]:
        if not r or li is None or li >= len(r) or not r[li].strip():
            continue
        if ai is not None and ai < len(r) and r[ai].strip().upper() != "TRUE":
            continue
        label = r[li].strip()
        props = {"source": ctx.snapshot.get("source")}
        if ui is not None and ui < len(r) and r[ui].strip():
            props["url"] = r[ui].strip()
        rid = r[0].strip() if r[0].strip() else label
        res.entities.append(Entity(ids.entity_id(typ.lower(), slugify(f"{prefix}-{rid}")), typ, label, props))
        n += 1
    res.series.append(Series(f"{slugify(prefix)}-rows", f"{prefix} 행 수", "csv_rows", day_points(ctx, n, "count"), unit="count", granularity="day"))
    res.count = n
    return res


@adapter("hf_models", hint="json")
def hf_models(ctx) -> Result:
    d = ctx.json()
    res = Result()
    if not isinstance(d, list):
        res.notes.append("not_a_list")
        return res
    for m in d[:int((ctx.cfg or {}).get("limit", 100))]:
        mid = m.get("id") or m.get("modelId")
        if not mid:
            continue
        ent = Entity(ids.entity_id("model", "hf-" + slugify(mid)), "Model", mid,
                     {k: v for k, v in {"hf_id": mid, "pipeline_tag": m.get("pipeline_tag"), "library_name": m.get("library_name"),
                                        "url": f"https://huggingface.co/{mid}"}.items() if v})
        res.entities.append(ent)
        if isinstance(m.get("downloads"), int):
            res.series.append(Series(f"hf-downloads-{slugify(mid)}", f"{mid} HF 다운로드", "hf_downloads",
                                     day_points(ctx, m["downloads"], "count"), unit="count", subject=ent.id, granularity="day"))
    res.count = len(res.entities)
    return res


@adapter("mcp_registry", hint="json")
def mcp_registry(ctx) -> Result:
    d = ctx.json()
    res = Result()
    items = d.get("servers") if isinstance(d, dict) else None
    if not isinstance(items, list):
        res.notes.append("no_servers")
        return res
    for i, it in enumerate(items):
        sv = it.get("server", it) if isinstance(it, dict) else None
        if not isinstance(sv, dict) or not sv.get("name"):
            continue
        meta = next(iter((it.get("_meta") or {}).values()), {}) if isinstance(it.get("_meta"), dict) else {}
        if meta.get("isLatest") is False:
            continue
        ent = Entity(ids.entity_id("tool", "mcp-" + slugify(sv["name"])), "Tool", sv.get("title") or sv["name"],
                     {k: v for k, v in {"mcp_name": sv["name"], "description": (sv.get("description") or "")[:300],
                                        "registry": "mcp"}.items() if v})
        res.entities.append(ent)
        if sv.get("version"):
            res.claims.append(Claim(ent.id, "latest_version", str(sv["version"]),
                                    f"MCP 레지스트리에서 {sv['name']}의 최신 버전은 {sv['version']}이다.",
                                    pointer(f"/servers/{i}/server/version", sv["version"])))
        if meta.get("status") in ("deprecated", "deleted"):
            res.claims.append(Claim(ent.id, "maintained_status", meta["status"], f"MCP 레지스트리가 {sv['name']}을(를) {meta['status']}로 표시했다.",
                                    pointer(f"/servers/{i}/_meta", meta.get("status"))))
    res.count = len(res.entities)
    return res


@adapter("kworb", hint="html")
def kworb(ctx) -> Result:
    """차트 표. 행마다 영상 엔티티와 chart_rank 주장(한정자 chart). 순위는 열 0, 제목은 첫 링크."""
    import lxml.html
    doc = lxml.html.document_fromstring(ctx.raw)
    chart = (ctx.cfg or {}).get("chart") or slugify(ctx.url.split("kworb.net", 1)[-1])
    res = Result()
    text = ctx.text.text
    for tr in doc.cssselect("table tbody tr"):
        tds = tr.findall("td")
        if len(tds) < 2:
            continue
        pos = tds[0].text_content().strip()
        a = tr.cssselect("a")
        if not pos.isdigit() or not a:
            continue
        title, href = " ".join(a[0].text_content().split()), a[0].get("href") or ""
        m = re.search(r"(?:youtu\.be/|v=)([\w-]{11})", href)
        slug = slugify(m.group(1)) if m else slugify(title)
        ent = Entity(ids.entity_id("video", slug), "Video", title, {"url": href} if href else None)
        res.entities.append(ent)
        sel = quote(text, title)
        if sel:
            res.claims.append(Claim(ent.id, "chart_rank", pos, f"Kworb {chart} 차트에서 \"{title}\"의 순위는 {pos}위다.", sel,
                                    qualifiers={"chart": chart}))
    res.count = len(res.entities)
    return res


@adapter("codex_features", hint="text")
def codex_features(ctx) -> Result:
    """`codex features list` 출력. 줄마다 '이름  단계  true|false' 꼴을 기능 엔티티와 단계 주장으로 낸다."""
    text = ctx.text.text
    res = Result()
    pos = 0
    for ln in text.split("\n"):
        m = re.match(r"^\s*([a-z][a-z0-9_]+)\s+([A-Za-z][\w-]*(?:\s[A-Za-z]+)?)\s+(true|false)\s*$", ln)
        if m:
            name, stage = m.group(1), m.group(2).strip().lower().replace(" ", "_")
            ent = Entity(ids.entity_id("feature", "codex-" + slugify(name)), "Feature", f"Codex {name}", {"codex_feature": name})
            res.entities.append(ent)
            sel = quote(text, ln.strip(), pos)
            if sel:
                res.claims.append(Claim(ent.id, "maintained_status", stage, f"Codex 기능 {name}의 단계는 {stage}이다(codex features list 출력).", sel))
        pos += len(ln) + 1
    res.count = len(res.entities)
    return res
