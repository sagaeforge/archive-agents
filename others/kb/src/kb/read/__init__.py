"""조회 코어(WP-04). CLI, HTTP, MCP가 공유한다. 프레임워크를 임포트하지 않는다.

모든 함수는 (con, ctx, ...)를 받는다. con은 `reading(ctx)`(요청마다 connect_ro로 연 읽기 트랜잭션 1개)이고
`envelope.read(ctx, fn, ...)`가 봉투까지 씌운다. 필터 SQL은 `visibility_sql` 한 함수만 만든다.
"""
from kb.read.cards import CardResult, render_cards
from kb.read.catalog import catalog, meta
from kb.read.changes import changes
from kb.read.ctx import (AsOfUnsupported, BadParam, ContentRemoved, CursorMismatch, EpochChanged, LimitTooLarge, NotFound,
                         NotReady, ReadCtx, ReadError, ReadTimeout, reading, visibility_sql)
from kb.read.envelope import envelope, read
from kb.read.facets import counts, facets
from kb.read.graph import neighbors, overview
from kb.read.history import history
from kb.read.nodes import get_claim, get_edge, get_node, list_nodes, node_body, node_claims, node_edges
from kb.read.series import series
from kb.read.snapshots import snapshot_meta, snapshot_raw, snapshot_text
from kb.read.tickets import get_ticket, tickets

__all__ = [
    "AsOfUnsupported", "BadParam", "CardResult", "ContentRemoved", "CursorMismatch", "EpochChanged", "LimitTooLarge",
    "NotFound", "NotReady", "ReadCtx", "ReadError", "ReadTimeout", "catalog", "changes", "counts", "envelope", "facets",
    "get_claim", "get_edge", "get_node", "get_ticket", "history", "list_nodes", "meta", "neighbors", "node_body",
    "node_claims", "node_edges", "overview", "read", "reading", "render_cards", "series", "snapshot_meta",
    "snapshot_raw", "snapshot_text", "tickets", "visibility_sql",
]
