"""표시 본문, 문단 색인, 파서 어댑터, 소스 레지스트리 동기화(WP-07).
하위 모듈: display, paragraphs, discover, adapters, pipeline, events, conflicts, registry_sync, tick_stage*."""
from kb.parse.display import Text, display_text


def __getattr__(name):
    if name == "ADAPTERS":
        from kb.parse import adapters
        return adapters.ADAPTERS
    raise AttributeError(name)


__all__ = ["ADAPTERS", "Text", "display_text"]
