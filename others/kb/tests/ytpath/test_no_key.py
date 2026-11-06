"""키·계정 없음, 쓰지 않는 경로 호출 0회, youtube.com 계열 요청 0건."""
import re
from pathlib import Path
from urllib.parse import urlsplit

from kb.collect import hostpolicy, registry
from kb.core import paths

REPO = Path(__file__).resolve().parents[2]
KEY_SOURCES = ["X02", "X04", "X05", "X07", "X08", "X09", "X10", "X18", "X19", "X20", "X21", "P01", "P02", "P03"]
KEY_PATTERNS = [r"AIza[0-9A-Za-z_\-]{20,}", r"ya29\.[0-9A-Za-z_\-]+", r"(?i)^\s*(YT|YOUTUBE|GOOGLE)[A-Z_]*(API_KEY|CLIENT_SECRET|REFRESH_TOKEN)\s*="]
YT_HOST = re.compile(r"(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$")


def test_no_key_or_oauth_config(env):
    assert not (REPO / "src/kb/commands/auth.py").exists()
    assert not (REPO / "sources/overlays/auth.yaml").exists()
    for d in (env.cfg, paths.config_dir()):
        for name in ("secrets.env", "oauth.json", "google_token.json", "token.json"):
            p = Path(d) / name
            if name == "secrets.env" and p.exists():
                txt = p.read_text(errors="ignore")
                assert not any(re.search(pt, txt, re.M) for pt in KEY_PATTERNS)
            else:
                assert not p.exists(), p
    for p in (REPO / "src/kb/ytpath").glob("*.py"):
        txt = p.read_text()
        assert not re.search(r"API_KEY|oauth|client_secret|refresh_token|Authorization|\bkey=", txt, re.I), p
    ov = (REPO / "sources/overlays/ytpath.yaml").read_text()
    assert not re.search(r"[?&]key=|API_KEY|oauth|token", ov, re.I)


def test_no_key_or_account_source_is_active(env):
    by_inv = {s.inventory_id: s for s in registry.load_registry()}
    on = [i for i in KEY_SOURCES if by_inv.get(i) and by_inv[i].enabled]
    assert on == []
    assert not any(s.id in ("src:yt-data-api",) and s.enabled for s in registry.load_registry())
    assert not any(s.policy.get("needs_contact") and s.enabled and s.id in ("src:yt-suggest", "src:google-trends")
                   for s in registry.load_registry())


def test_no_request_to_youtube_family_hosts(env):
    """두 소스의 URL 전부와 리다이렉트 없는 호스트가 youtube.com 계열이 아니고, 정책이 그 계열을 거부한다."""
    srcs = {s.id: s for s in registry.load_registry()}
    hosts = set()
    for sid in ("src:yt-suggest", "src:google-trends"):
        for u in srcs[sid].all_urls():
            h = urlsplit(u).hostname
            hosts.add(h)
            assert not YT_HOST.search(h) and "suggestqueries" not in h, u
    assert hosts == {"www.google.com", "trends.google.com"}
    for h in ("www.youtube.com", "suggestqueries-clients6.youtube.com", "i.ytimg.com"):
        assert not hostpolicy.host_allowed(h)
    for s in srcs.values():
        if s.enabled:
            assert not any(YT_HOST.search(h) for h in s.hosts()), s.id


def test_forbidden_paths_have_no_code_or_call(env):
    code = "\n".join(p.read_text() for p in (REPO / "src/kb/ytpath").glob("*.py"))
    for bad in ("yt_dlp", "yt-dlp", "innertube", "youtubei", "suggestqueries", "youtube.com/feeds", "googleapis.com/youtube",
                "websub", "pubsubhubbub", "build(\"youtube\""):
        assert bad.lower() not in code.lower(), bad
    ov = (REPO / "sources/overlays/ytpath.yaml").read_text()
    for bad in ("suggestqueries", "youtube.com", "youtubei", "googleapis"):
        assert bad not in re.sub(r"(?m)^\s*(#|reason:).*$", "", ov), bad
    assert not (REPO / "src/kb/commands/auth.py").exists()
