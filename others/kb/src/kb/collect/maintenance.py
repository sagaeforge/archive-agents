"""WP-06 내부 작업(sources/internal.d/collect.yaml)."""
from __future__ import annotations

from kb.collect.state import State


def prune_fetch_log(ctx=None) -> dict:
    with State() as st:
        return {"pruned": st.prune_log()}
