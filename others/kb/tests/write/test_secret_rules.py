import hashlib
import re
import warnings

from kb.write import secrets_scan as s


def h(x, n):
    return hashlib.sha256(x.encode()).hexdigest()[:n]


def ids(text, path=None):
    return sorted({x.rule for x in s.scan_text(text, path)})


def test_rules_compile_without_warnings():
    s._load.cache_clear()
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        rs = s.load_rules()
    assert len(rs.rules) == 221
    assert rs.skipped == ["pkcs12-file"]
    assert not any("[[:" in r.regex.pattern for r in rs.rules)


def test_posix_class_rule_hits():
    at = "pat" + "AbCdEfGhIjKlMn" + "." + h("b", 32) + h("c", 32)
    assert "airtable-personnal-access-token" in ids("airtable " + at)
    assert "airtable-personnal-access-token" not in ids("airtable pat" + "a" * 14 + "." + "g" * 64)  # 16진이 아님


def test_entropy_floor():
    assert "github-pat" in ids("ghp_" + h("a", 36))
    assert "github-pat" not in ids("ghp_" + "ab" * 18)  # 엔트로피 미달


def test_global_allowlist_stopwords_and_regexes():
    u = "014df517-39d1-4453-b7b3-9930c563627c"
    assert ids(f'api_key = "{u}"') == []
    assert "generic-api-key" in ids('api_key = "6f2c9a1e-77b4-4d0c-9e51-0a8b3c4d5e6f"')
    rs = s.load_rules()
    assert rs.allow.allows("${SECRET_VALUE}", "x", "x", None)  # 전역 regexes: 치환 변수 표기
    assert rs.allow.allows("my-abcdefghijklmnopqrstuvwxyz-x", "x", "x", None)  # 전역 stopwords


def test_rule_allowlist_regex():
    assert "aws-access-token" not in ids("AKIAIOSFODNN7EXAMPLE")  # 규칙별 allowlist .+EXAMPLE$
    assert "aws-access-token" in ids("AKIA" + "QWERTYUIOPASDFGH")
    assert "gcp-api-key" not in ids("AIzaSyabcdefghijklmnopqrstuvwxyz1234567")
    assert "gcp-api-key" in ids("AIzaSy" + h("q", 33))


def test_path_rules_need_filename():
    php = "'secret_key' => 'sk_" + h("z", 29) + "'"
    assert "freemius-secret-key" not in ids(php)
    assert "freemius-secret-key" not in ids(php, "a.txt")
    assert "freemius-secret-key" in ids(php, "a.php")
    assert "pkcs12-file" not in {r.id for r in s.load_rules().rules}


def test_global_path_allowlist_skips_file():
    assert ids("ghp_" + h("a", 36), "package-lock.json") == []
    assert "github-pat" in ids("ghp_" + h("a", 36), "notes.md")


def test_extra_rules():
    assert "kb-private-key-header" in ids("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")
    assert "kb-env-high-entropy" in ids("API_SECRET_TOKEN=Zk3fQ9xLm2Vb7Rt8Yw1Ns4Hd6Jc0Pa5G")
    assert ids("DISABLE_AUTOUPDATER=1\nNODE_ENV=production\nHOME=/home/user/some/long/path/value1") == []
    assert ids("URL=https://example.com/a/very/long/path/with-9-digits-1234567") == []


def test_hits_never_carry_secret_value():
    hit = s.scan_text("ghp_" + h("a", 36))[0]
    assert set(hit.__dataclass_fields__) == {"rule", "start", "end"}
