"""실운영 ops.db fetch_log에 거부 호스트 요청이 0건인지 읽기 전용으로 확인한다 (WP-21)."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml

LIVE = Path("/home/user/sagae-kb-data")
DENIED = ["youtube.com", "googlevideo.com", "suggestqueries.google.com", "suggestqueries-clients6.youtube.com",
          "trends.google.com", "sec.gov", "www.netflix.com", "www.kobaco.co.kr"]


def _db() -> sqlite3.Connection:
    home = Path(os.environ.get("KB_HOME") or LIVE)
    p = home / "ops" / "ops.db"
    if not p.exists():
        pytest.skip(f"없음: {p}")
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def _decision_1_exempt() -> set:
    """결정 1(ADR-0002)이 승인이면 Trends RSS만 예외다. overlay host_allow와 교차해 overlay가 빠지면 다시 거부로 판정한다."""
    from kb.core import config
    if not config.decision_ok(1):
        return set()
    overlay = Path(__file__).resolve().parents[2] / "sources" / "overlays" / "ytpath.yaml"
    return set(yaml.safe_load(overlay.read_text(encoding="utf-8")).get("host_allow") or []) & {"trends.google.com"}


def test_no_denied_host_requests():
    c = _db()
    hosts = {r[0].lower() for r in c.execute("select distinct host from fetch_log") if r[0]}
    exempt = _decision_1_exempt()
    bad = sorted(h for h in hosts for d in DENIED if (h == d or h.endswith("." + d)) and h not in exempt)
    assert bad == [], bad


def test_trends_only_rss_paths():
    """예외 호스트는 RSS와 robots.txt만 요청한다. /explore 등 다른 경로는 결정 1 밖이다."""
    c = _db()
    urls = [r[0] for r in c.execute("select url from fetch_log where lower(host)='trends.google.com'")]
    bad = [u for u in urls if urlsplit(u).path not in ("/trending/rss", "/robots.txt")]
    assert bad == [], bad


def test_support_google_allowed_not_flagged():
    c = _db()
    hosts = {r[0].lower() for r in c.execute("select distinct host from fetch_log") if r[0]}
    assert not any(h == "google.com" for h in hosts)   # support.google.com은 허용, 거부 목록에 없다
