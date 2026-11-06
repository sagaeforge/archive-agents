"""매니페스트 docs/intake/session-research.yaml 읽기와 형식 검사."""
from __future__ import annotations

from pathlib import Path

from kb.core import paths
from kb.intake.errors import IntakeError

TREATS = ("full", "filtered", "jsonl_filter", "urls_only", "index", "versions_only", "excluded")
REQUIRED = ("id", "session", "project", "topic", "researched_on", "treat")
URL_TREATS = ("full", "filtered", "urls_only", "jsonl_filter")


def default_path() -> Path:
    return paths.share_dir() / "docs" / "intake" / "session-research.yaml"


def default_copy_dir() -> Path:
    return Path.home() / ".local" / "share" / "sagae-kb" / "intake"


def load_manifest(path: str | Path | None = None) -> dict:
    import yaml
    p = Path(path) if path else default_path()
    try:
        doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    except OSError as e:
        raise IntakeError("E_MANIFEST", f"매니페스트를 읽지 못함: {p.name}: {e.strerror}") from None
    except yaml.YAMLError as e:
        raise IntakeError("E_MANIFEST", f"YAML 오류: {e}") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
        raise IntakeError("E_MANIFEST", "items 목록이 필요하다")
    seen = set()
    for it in doc["items"]:
        for k in REQUIRED:
            if it.get(k) in (None, ""):
                raise IntakeError("E_MANIFEST", f"항목 {it.get('id')!r}: {k} 필수")
        if it["id"] in seen or ":" in str(it["id"]):
            raise IntakeError("E_MANIFEST", f"id 중복 또는 ':' 포함: {it['id']}")
        seen.add(it["id"])
        if it["treat"] not in TREATS:
            raise IntakeError("E_MANIFEST", f"{it['id']}: treat 값 오류 {it['treat']!r}")
        if it["treat"] != "excluded" and not (it.get("path") or it.get("git_show")):
            raise IntakeError("E_MANIFEST", f"{it['id']}: path 또는 git_show 필요")
        it["researched_on"] = str(it["researched_on"])
    doc.setdefault("copy_dir", str(default_copy_dir()))
    return doc
