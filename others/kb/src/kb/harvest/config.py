"""kb harvest 설정. 값은 sources/internal.d/harvest.yaml의 settings에서 읽고, 없는 키는 아래 기본값을 쓴다.

모든 상한은 한 번의 실행(tick 작업 한 번 또는 kb harvest 한 번)에 걸린다. 읽기 상한은 원본을 몇 바이트까지 여는가,
쓰기 상한은 기록과 티켓을 몇 건까지 남기는가다. 상한을 넘은 일은 버리지 않고 다음 실행이 잇는다(멱등).
"""
from __future__ import annotations

import glob
import os
from dataclasses import dataclass, fields, replace
from pathlib import Path

from kb.core import paths

# 이름에 이 정규식이 걸리는 프로젝트 폴더는 스크래치패드나 시험 폴더다. 원본 읽기 전에 뺀다
DEFAULT_EXCLUDE_PROJECTS = (
    r"scratchpad",
    r"test-tmp",
    r"^-(?:var-)?tmp-claude-\d+-",
    r"^-home-[^-]+--cache-",
)
# 보고서가 아닌 에이전트(감시, 탐침, 시험용)
DEFAULT_EXCLUDE_AGENT_TYPES = ("team-watcher", "probe", "probe2", "turncount")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    enabled: bool = True            # False면 tick 작업은 아무것도 하지 않는다(수동 kb harvest는 그대로 돈다)
    claude_projects: str = "~/.claude/projects"
    repos: tuple[str, ...] = ("~/sagae-*",)
    research_glob: str = "docs/research/*.md"
    exclude_projects: tuple[str, ...] = DEFAULT_EXCLUDE_PROJECTS
    exclude_agent_types: tuple[str, ...] = DEFAULT_EXCLUDE_AGENT_TYPES
    exclude_memory_files: tuple[str, ...] = ("MEMORY.md",)
    exclude_memory_types: tuple[str, ...] = ("user",)   # 메모리 머리말 metadata.type. user(사용자 프로필)는 거두지 않는다
    session: str = "harvest"
    # 원본 읽기
    min_age_s: int = 600            # 이보다 최근에 고친 원본은 쓰는 중일 수 있어 다음 실행으로 미룬다
    max_sources: int = 1000         # 한 번에 훑는 원본 수 상한(비정상 폴더 방어)
    max_read_bytes: int = 4 * 1024 * 1024   # 원본 하나를 여는 바이트 상한. 넘으면 건너뛴다
    transcript_tail_bytes: int = 1024 * 1024  # 에이전트 전사는 끝에서 이만큼만 읽는다
    # 보고서 길이 거름
    min_report_chars: int = 800
    max_report_chars: int = 20000
    min_result_chars: int = 80      # 워크플로우 결과 한 건의 최소 길이(시험용 한 단어 결과를 거른다)
    min_body_chars: int = 40        # 정화 뒤 본문이 이보다 짧으면 저장하지 않는다
    # 쓰기 상한
    max_body_bytes: int = 128 * 1024
    max_writes: int = 40            # 새 기록과 새 버전의 합
    max_write_bytes: int = 2 * 1024 * 1024
    max_urls_per_source: int = 20
    max_urls: int = 60              # 티켓에 새로 올리는 URL 수
    deadline_s: float = 120.0

    def __post_init__(self):
        if self.max_body_bytes > self.max_write_bytes:
            raise ConfigError("max_body_bytes는 max_write_bytes 이하여야 한다(기록 하나가 상한을 넘으면 영영 못 쓴다)")

    def project_regexes(self):
        import re
        return [re.compile(p) for p in self.exclude_projects]

    def claude_dir(self) -> Path:
        return Path(os.path.expanduser(self.claude_projects))

    def repo_dirs(self) -> list[Path]:
        """저장소 체크아웃 목록. .git이 있는 폴더만(작업 트리 포함)."""
        out: dict[str, Path] = {}
        for pat in self.repos:
            for m in sorted(glob.glob(os.path.expanduser(pat))):
                p = Path(m)
                if p.is_dir() and (p / ".git").exists():
                    out[str(p.resolve())] = p
        return [out[k] for k in sorted(out)]


_INT = {"min_age_s", "max_sources", "max_read_bytes", "transcript_tail_bytes", "min_report_chars", "max_report_chars",
        "min_result_chars", "min_body_chars", "max_body_bytes", "max_writes", "max_write_bytes",
        "max_urls_per_source", "max_urls"}
_TUPLE = {"repos", "exclude_projects", "exclude_agent_types", "exclude_memory_files", "exclude_memory_types"}
_STR = {"claude_projects", "research_glob", "session"}
_BOOL = {"enabled"}


def _coerce(name: str, v):
    if name in _INT:
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ConfigError(f"{name}: 0 이상의 정수여야 한다: {v!r}")
        return v
    if name == "deadline_s":
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
            raise ConfigError(f"{name}: 양수여야 한다: {v!r}")
        return float(v)
    if name in _TUPLE:
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple)) or not all(isinstance(x, str) for x in v):
            raise ConfigError(f"{name}: 문자열 목록이어야 한다")
        return tuple(v)
    if name in _BOOL:
        if not isinstance(v, bool):
            raise ConfigError(f"{name}: true 또는 false여야 한다: {v!r}")
        return v
    if name in _STR:
        if not isinstance(v, str) or not v.strip():
            raise ConfigError(f"{name}: 비어 있지 않은 문자열이어야 한다")
        return v
    raise ConfigError(f"알 수 없는 설정 키: {name}")


def yaml_path() -> Path:
    return paths.share_dir() / "sources" / "internal.d" / "harvest.yaml"


def from_dict(doc: dict | None, base: Config | None = None) -> Config:
    cfg = base or Config()
    if not doc:
        return cfg
    known = {f.name for f in fields(Config)}
    upd = {}
    for k, v in doc.items():
        if k not in known:
            raise ConfigError(f"알 수 없는 설정 키: {k}")
        upd[k] = _coerce(k, v)
    return replace(cfg, **upd)


def load(path: str | Path | None = None, **overrides) -> Config:
    """harvest.yaml의 settings를 읽고 overrides(None은 무시)를 덮는다. 파일이 없으면 기본값이다."""
    p = Path(path) if path else yaml_path()
    doc: dict = {}
    if p.is_file():
        import yaml
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise ConfigError(f"{p.name}: 최상위는 객체여야 한다")
        s = raw.get("settings") or {}
        if not isinstance(s, dict):
            raise ConfigError(f"{p.name}: settings는 객체여야 한다")
        doc = s
    cfg = from_dict(doc)
    return from_dict({k: v for k, v in overrides.items() if v is not None}, cfg)
